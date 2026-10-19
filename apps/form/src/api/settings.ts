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
