import { credentialMailFor, type CredentialMailStatus } from './credentials/mail.js';
import { assertAccountActive } from './lifecycle/guards.js';
import { DomainError } from './errors.js';
import { isPhoneEmail } from './phone/challenges.js';
import type { Sqlite } from './storage.js';

export type SignInMethod = 'emailPassword' | 'google' | 'apple' | 'phone';

type SessionAction<Scope extends string> = {
  supported: true;
  method: 'POST';
  path: string;
  scope: Scope;
  authentication: 'currentFormSession';
  requestBody: 'emptyObject' | 'ownSessionToken';
};

export type AccountSettings = {
  accountId: string;
  identity: {
    displayName: string;
    displayNameSource: 'formProfile';
    email: string | null;
    emailVerified: boolean;
    phoneNumber: string | null;
    signInMethods: SignInMethod[];
  };
  capabilities: {
    changePassword: { supported: boolean; status: 'available' | 'unavailable' };
    changeEmail: { supported: boolean; status: CredentialMailStatus };
    passwordRecovery: { supported: boolean; status: CredentialMailStatus };
    signOut: SessionAction<'currentFormSession'>;
    revokeSession: SessionAction<'selectedOwnFormSession'>;
    revokeOtherSessions: SessionAction<'otherFormSessions'>;
    revokeAllSessions: SessionAction<'allFormSessions'>;
    accountDeletion: {
      supported: false;
      status: 'unavailable';
      reason: 'retentionCleanupNotImplemented';
    };
  };
  policies: {
    sessions: {
      providerLogout: 'notClaimed';
      billingCancellation: 'notIncluded';
      deviceDataErasure: 'notIncluded';
    };
    reminders: {
      preferenceField: 'remindersEnabled';
      preferencePath: '/v1/me/preferences';
      effect: 'preferenceOnly';
      osPermission: 'unverified';
      scheduling: 'unverified';
      delivery: 'unverified';
    };
    privacy: {
      status: 'pendingIntegration';
      contractOwner: 'rootBodyContract';
      bodyRetention: 'unavailable';
      accountDataDeletion: 'unavailable';
    };
  };
};

type IdentityRow = {
  email: string;
  emailVerified: number;
  phoneNumber: string | null;
  displayName: unknown;
};

/** Both IDs must come from validated session middleware, never request parameters. */
export function readAccountSettings(db: Sqlite, authenticatedAccountId: string, authUserId: string): AccountSettings {
  if (!authenticatedAccountId || !authUserId) throw new DomainError(403, 'account_session_mismatch');
  return db.transaction((): AccountSettings => {
    assertAccountActive(db, authenticatedAccountId);
    // Verify the immutable mapping before reading any account-owned metadata.
    const identity = db.prepare(`
      SELECT u.email, u.emailVerified,
        CASE WHEN u.phoneNumberVerified = 1 THEN u.phoneNumber ELSE NULL END AS phoneNumber,
        CASE WHEN json_type(p.data, '$.name') = 'text' THEN json_extract(p.data, '$.name') ELSE NULL END AS displayName
      FROM form_accounts f JOIN "user" u ON u.id = f.auth_user_id
      LEFT JOIN documents p ON p.account_id = f.id AND p.kind = 'profile'
      WHERE f.id = ? AND f.auth_user_id = ?
    `).get(authenticatedAccountId, authUserId) as IdentityRow | undefined;
    if (!identity) throw new DomainError(403, 'account_session_mismatch');
    if (typeof identity.displayName !== 'string' || !identity.displayName.trim())
      throw new DomainError(503, 'settings_profile_unavailable');

    const email = isPhoneEmail(identity.email) ? null : identity.email;
    const phoneNumber = identity.phoneNumber && /^\+[1-9][0-9]{7,14}$/.test(identity.phoneNumber) ? identity.phoneNumber : null;
    const providers = new Set((db.prepare('SELECT providerId FROM account WHERE userId = ?')
      .all(authUserId) as { providerId: string }[]).map(row => row.providerId));
    const signInMethods: SignInMethod[] = [];
    if (providers.has('credential')) signInMethods.push('emailPassword');
    if (providers.has('google')) signInMethods.push('google');
    if (providers.has('apple')) signInMethods.push('apple');
    if (phoneNumber !== null) signInMethods.push('phone');

    return {
      accountId: authenticatedAccountId,
      identity: {
        displayName: identity.displayName, displayNameSource: 'formProfile', email,
        emailVerified: email !== null && identity.emailVerified === 1, phoneNumber, signInMethods,
      },
      capabilities: {
        changePassword: { supported: signInMethods.includes('emailPassword'), status: signInMethods.includes('emailPassword') ? 'available' : 'unavailable' },
        changeEmail: { supported: signInMethods.includes('emailPassword') && credentialMailFor(db).status() !== 'unconfigured', status: credentialMailFor(db).status() },
        passwordRecovery: { supported: signInMethods.includes('emailPassword') && credentialMailFor(db).status() !== 'unconfigured', status: credentialMailFor(db).status() },
        signOut: {
          supported: true, method: 'POST', path: '/api/auth/sign-out', scope: 'currentFormSession',
          authentication: 'currentFormSession', requestBody: 'emptyObject',
        },
        revokeSession: {
          supported: true, method: 'POST', path: '/api/auth/revoke-session', scope: 'selectedOwnFormSession',
          authentication: 'currentFormSession', requestBody: 'ownSessionToken',
        },
        revokeOtherSessions: {
          supported: true, method: 'POST', path: '/api/auth/revoke-other-sessions', scope: 'otherFormSessions',
          authentication: 'currentFormSession', requestBody: 'emptyObject',
        },
        revokeAllSessions: {
          supported: true, method: 'POST', path: '/api/auth/revoke-sessions', scope: 'allFormSessions',
          authentication: 'currentFormSession', requestBody: 'emptyObject',
        },
        accountDeletion: { supported: false, status: 'unavailable', reason: 'retentionCleanupNotImplemented' },
      },
      policies: {
        sessions: { providerLogout: 'notClaimed', billingCancellation: 'notIncluded', deviceDataErasure: 'notIncluded' },
        reminders: {
          preferenceField: 'remindersEnabled', preferencePath: '/v1/me/preferences', effect: 'preferenceOnly',
          osPermission: 'unverified', scheduling: 'unverified', delivery: 'unverified',
        },
        privacy: {
          status: 'pendingIntegration', contractOwner: 'rootBodyContract', bodyRetention: 'unavailable', accountDataDeletion: 'unavailable',
        },
      },
    };
  })();
}
