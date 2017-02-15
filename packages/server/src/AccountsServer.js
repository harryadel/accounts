// @flow

import { isString, isPlainObject, find, includes } from 'lodash';
import jwt from 'jsonwebtoken';
import {
  AccountsError,
  toUsernameAndEmail,
  validators,
} from '@accounts/common';
import type {
  UserObjectType,
  CreateUserType,
  PasswordLoginUserType,
  LoginReturnType,
  TokensType,
  SessionType,
} from '@accounts/common';
import config from './config';
import type { DBInterface } from './DBInterface';
import { verifyPassword } from './encryption';
import {
  generateAccessToken,
  generateRefreshToken,
  generateRandomToken,
} from './tokens';
import Email from './email';
import emailTemplates from './emailTemplates';

export class AccountsServer {
  _options: Object
  db: DBInterface

  config(options: Object, db: DBInterface) {
    this._options = {
      ...config,
      ...options,
    };
    if (!db) {
      throw new AccountsError('A database driver is required');
    }
    this.db = db;
    this.email = new Email(config.email);
    this.emailTemplates = emailTemplates;
  }

  options(): Object {
    return this._options;
  }

  // eslint-disable-next-line max-len
  async loginWithPassword(user: PasswordLoginUserType, password: string, ip: ?string, userAgent: ?string): Promise<LoginReturnType> {
    if (!user || !password) {
      throw new AccountsError('Unrecognized options for login request', user, 400);
    }
    if ((!isString(user) && !isPlainObject(user)) || !isString(password)) {
      throw new AccountsError('Match failed', user, 400);
    }

    let foundUser;

    if (this._options.passwordAuthenticator) {
      try {
        foundUser = await this._externalPasswordAuthenticator(
          this._options.passwordAuthenticator,
          user,
          password);
      } catch (e) {
        throw new AccountsError(e, user, 403);
      }
    } else {
      foundUser = await this._defaultPasswordAuthenticator(user, password);
    }

    if (!foundUser) {
      throw new AccountsError('User not found', user, 403);
    }

    // $FlowFixMe
    const sessionId = await this.db.createSession(foundUser.id, ip, userAgent);
    const { accessToken, refreshToken } = this.createTokens(sessionId);

    return {
      sessionId,
      user: foundUser,
      tokens: {
        refreshToken,
        accessToken,
      },
    };
  }

  // eslint-disable-next-line max-len
  async _externalPasswordAuthenticator(authFn: Function, user: PasswordLoginUserType, password: string): Promise<any> {
    return authFn(user, password);
  }

  async _defaultPasswordAuthenticator(user: PasswordLoginUserType, password: string): Promise<any> {
    const { username, email, id } = isString(user)
      ? toUsernameAndEmail({ user })
      : toUsernameAndEmail({ ...user });

    let foundUser;

    if (id) {
      foundUser = await this.db.findUserById(id);
    } else if (username) {
      foundUser = await this.db.findUserByUsername(username);
    } else if (email) {
      foundUser = await this.db.findUserByEmail(email);
    }

    if (!foundUser) {
      throw new AccountsError('User not found', user, 403);
    }
    const hash = await this.db.findPasswordHash(foundUser.id);
    if (!hash) {
      throw new AccountsError('User has no password set', user, 403);
    }

    const isPasswordValid = await verifyPassword(password, hash);

    if (!isPasswordValid) {
      throw new AccountsError('Incorrect password', user, 403);
    }

    return foundUser;
  }

  async createUser(user: CreateUserType): Promise<string> {
    if (!validators.validateUsername(user.username) && !validators.validateEmail(user.email)) {
      throw new AccountsError(
        'Username or Email is required',
        {
          username: user && user.username,
          email: user && user.email,
        },
      );
    }
    if (user.username && await this.db.findUserByUsername(user.username)) {
      throw new AccountsError('Username already exists', { username: user.username });
    }
    if (user.email && await this.db.findUserByEmail(user.email)) {
      throw new AccountsError('Email already exists', { email: user.email });
    }

    // TODO Accounts.onCreateUser
    const userId: string = await this.db.createUser({
      username: user.username,
      email: user.email && user.email.toLowerCase(),
      password: user.password,
      profile: user.profile,
    });

    return userId;
  }

  // eslint-disable-next-line max-len
  async refreshTokens(accessToken: string, refreshToken: string, ip: string, userAgent: string): Promise<LoginReturnType> {
    if (!isString(accessToken) || !isString(refreshToken)) {
      throw new AccountsError('An accessToken and refreshToken are required');
    }

    let sessionId;
    try {
      jwt.verify(refreshToken, this._options.tokenSecret);
      const decodedAccessToken = jwt.verify(accessToken, this._options.tokenSecret, {
        ignoreExpiration: true,
      });
      sessionId = decodedAccessToken.data.sessionId;
    } catch (err) {
      throw new AccountsError('Tokens are not valid');
    }

    const session : SessionType = await this.db.findSessionById(sessionId);
    if (!session) {
      throw new AccountsError('Session not found');
    }

    if (session.valid) {
      const user = await this.db.findUserById(session.userId);
      if (!user) {
        throw new AccountsError('User not found', { id: session.userId });
      }
      const tokens = this.createTokens(sessionId);
      await this.db.updateSession(sessionId, ip, userAgent);
      return {
        sessionId,
        user,
        tokens,
      };
    } else { // eslint-disable-line no-else-return
      throw new AccountsError('Session is no longer valid', { id: session.userId });
    }
  }

  createTokens(sessionId: string): TokensType {
    const { tokenSecret, tokenConfigs } = this._options;
    const accessToken = generateAccessToken({
      data: {
        sessionId,
      },
      secret: tokenSecret,
      config: tokenConfigs.accessToken,
    });
    const refreshToken = generateRefreshToken({
      secret: tokenSecret,
      config: tokenConfigs.refreshToken,
    });
    return { accessToken, refreshToken };
  }

  async logout(accessToken: string): Promise<void> {
    const session : SessionType = await this.findSessionByAccessToken(accessToken);
    if (session.valid) {
      const user = await this.db.findUserById(session.userId);
      if (!user) {
        throw new AccountsError('User not found', { id: session.userId });
      }
      await this.db.invalidateSession(session.sessionId);
    } else { // eslint-disable-line no-else-return
      throw new AccountsError('Session is no longer valid', { id: session.userId });
    }
  }

  async resumeSession(accessToken: string): Promise<?UserObjectType> {
    const session : SessionType = await this.findSessionByAccessToken(accessToken);
    if (session.valid) {
      const user = await this.db.findUserById(session.userId);
      if (!user) {
        throw new AccountsError('User not found', { id: session.userId });
      }

      if (this._options.resumeSessionValidator) {
        try {
          await this._options.resumeSessionValidator(user, session);
        } catch (e) {
          throw new AccountsError(e, { id: session.userId }, 403);
        }
      }

      return user;
    }
    return null;
  }

  async findSessionByAccessToken(accessToken: string): Promise<SessionType> {
    if (!isString(accessToken)) {
      throw new AccountsError('An accessToken is required');
    }

    let sessionId;
    try {
      const decodedAccessToken = jwt.verify(accessToken, this._options.tokenSecret);
      sessionId = decodedAccessToken.data.sessionId;
    } catch (err) {
      throw new AccountsError('Tokens are not valid');
    }

    const session : SessionType = await this.db.findSessionById(sessionId);
    if (!session) {
      throw new AccountsError('Session not found');
    }

    return session;
  }

  findUserByEmail(email: string): Promise<?UserObjectType> {
    return this.db.findUserByEmail(email);
  }

  findUserByUsername(username: string): Promise<?UserObjectType> {
    return this.db.findUserByUsername(username);
  }

  findUserById(userId: string): Promise<?UserObjectType> {
    return this.db.findUserById(userId);
  }

  addEmail(userId: string, newEmail: string, verified: boolean): Promise<void> {
    return this.db.addEmail(userId, newEmail, verified);
  }

  removeEmail(userId: string, email: string): Promise<void> {
    return this.db.removeEmail(userId, email);
  }

  async verifyEmail(token: string): Promise<void> {
    const user = await this.db.findUserByEmailVerificationToken(token);
    if (!user) {
      throw new AccountsError('Verify email link expired');
    }
    const tokenRecord = find(user.services.email.verificationTokens,
                             (t: Object) => t.token === token);
    if (!tokenRecord) {
      throw new AccountsError('Verify email link expired');
    }
    // TODO check time for expiry date
    const emailRecord = find(user.emails, (e: Object) => e.address === tokenRecord.address);
    if (!emailRecord) {
      throw new AccountsError('Verify email link is for unknown address');
    }
    await this.db.verifyEmail(user.id, emailRecord);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await this.db.findUserByResetPasswordToken(token);
    if (!user) {
      throw new AccountsError('Reset password link expired');
    }
    const resetTokenRecord = find(user.services.password.resetTokens,
                                  (t: Object) => t.token === token);
    if (!resetTokenRecord) {
      throw new AccountsError('Reset password link expired');
    }
    // TODO check time for expiry date
    if (!includes(user.emails.map((email: string) => email.address), resetTokenRecord.email)) {
      throw new AccountsError('Token has invalid email address');
    }
    // Change the user password and remove the old token
    await this.db.setResetPasssword(user.id, resetTokenRecord.email, newPassword, token);
    // Changing the password should invalidate existing sessions
    this.db.invalidateAllSessions(user.id);
  }

  setPassword(userId: string, newPassword: string): Promise<void> {
    return this.db.setPasssword(userId, newPassword);
  }

  async setProfile(userId: string, profile: Object): Promise<void> {
    const user = await this.db.findUserById(userId);
    if (!user) {
      throw new AccountsError('User not found', { id: userId });
    }
    await this.db.setProfile(userId, profile);
  }

  async updateProfile(userId: string, profile: Object): Promise<Object> {
    const user = await this.db.findUserById(userId);
    if (!user) {
      throw new AccountsError('User not found', { id: userId });
    }
    const res = await this.db.setProfile(userId, { ...user.profile, ...profile });
    return res;
  }

  async sendVerificationEmail(userId: string, address: string): Promise<void> {
    const user = await this.db.findUserById(userId);
    if (!user) {
      throw new AccountsError('User not found', { id: userId });
    }
    // If no address provided find the first unverified email
    if (!address) {
      const email = find(user.emails, (e: string) => !e.verified);
      address = email && email.address; // eslint-disable-line no-param-reassign
    }
    // Make sure the address is valid
    if (!address || !includes(user.emails.map((email: string) => email.address), address)) {
      throw new AccountsError('No such email address for user');
    }
    const token = generateRandomToken();
    await this.db.addEmailVerificationToken(userId, address, token);
    const verifyEmailUrl = `${this._options.siteUrl}/verify-email/${token}`;
    await this.email.sendMail({
      from: this.emailTemplates.verifyEmail.from ?
        this.emailTemplates.verifyEmail.from : this.emailTemplates.from,
      to: address,
      subject: this.emailTemplates.verifyEmail.subject(user),
      text: this.emailTemplates.verifyEmail.text(user, verifyEmailUrl),
    });
  }

  async sendResetPasswordEmail(userId: string, address: string): Promise<void> {
    const user = await this.db.findUserById(userId);
    if (!user) {
      throw new AccountsError('User not found', { id: userId });
    }
    // Pick the first email if we weren't passed an email
    if (!address && user.emails && user.emails[0]) {
      address = user.emails[0].address; // eslint-disable-line no-param-reassign
    }
    // Make sure the address is valid
    if (!address || !includes(user.emails.map((email: string) => email.address), address)) {
      throw new AccountsError('No such email address for user');
    }
    const token = generateRandomToken();
    await this.db.addPasswordResetToken(userId, address, token);
    const resetPasswordUrl = `${this._options.siteUrl}/reset-password/${token}`;
    await this.email.sendMail({
      from: this.emailTemplates.resetPassword.from ?
        this.emailTemplates.resetPassword.from : this.emailTemplates.from,
      to: address,
      subject: this.emailTemplates.resetPassword.subject(user),
      text: this.emailTemplates.resetPassword.text(user, resetPasswordUrl),
    });
  }
}

export default new AccountsServer();
