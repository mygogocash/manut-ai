/// The phone's passkey: made once at pairing, and used for every Allow (docs/remote-access.md, "Each decision"). The
/// browser makes and keeps it (iCloud Keychain on an iPhone, the Google Password Manager on Android); the page only asks
/// it to sign. Both calls need Face ID, a fingerprint or the phone's passcode (`userVerification: "required"`), and both
/// are made straight from the person's tap, since Safari refuses a passkey prompt the person did not start.
///
/// What a page can never do with it: read its private key, make it sign without the person, or delete it.

export interface PasskeyCreate {
  /// The relying party: this page's host, which the Mac names too.
  readonly rpId: string;
  /// The Mac's 32 random bytes for this registration.
  readonly challenge: Uint8Array;
  /// This phone's device id, which the Mac sent as the passkey's user.
  readonly userId: string;
  /// The name the phone's passwords list shows for it.
  readonly label: string;
}

export interface PasskeyGet {
  readonly rpId: string;
  /// What the passkey signs: the decision challenge the phone computed (`decisionChallenge`).
  readonly challenge: Uint8Array;
  readonly credentialId: Uint8Array;
}

export interface Registration {
  readonly credentialId: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
}

export interface Assertion extends Registration {
  readonly signature: Uint8Array;
}

/// The person closed the prompt, or the browser refused it because it did not come from a tap. Either way the person
/// can press again.
export class PasskeyCancelled extends Error {
  constructor() {
    super("The passkey prompt was closed.");
    this.name = "PasskeyCancelled";
  }
}

/// Anything else: no passkey support, another site's relying party, a broken answer.
export class PasskeyFailed extends Error {
  constructor() {
    super("The phone could not use a passkey.");
    this.name = "PasskeyFailed";
  }
}

export interface Passkeys {
  /// Whether this browser can make and use a passkey at all.
  readonly available: boolean;
  create(request: PasskeyCreate): Promise<Registration>;
  get(request: PasskeyGet): Promise<Assertion>;
}

const bytes = (buffer: ArrayBuffer | ArrayBufferView): Uint8Array =>
  buffer instanceof ArrayBuffer ? new Uint8Array(buffer.slice(0)) : new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

const own = (data: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return copy;
};

function failure(error: unknown): Error {
  // NotAllowedError is both a closed prompt and a prompt that was not started from a tap; AbortError is a prompt the page
  // or the system cancelled. Each can be pressed again.
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  return name === "NotAllowedError" || name === "AbortError" ? new PasskeyCancelled() : new PasskeyFailed();
}

/// The browser's own WebAuthn, through `navigator.credentials`.
export function browserPasskeys(): Passkeys {
  const available = typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
  return {
    available,
    create: async (request) => {
      if (!available) throw new PasskeyFailed();
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.create({
          publicKey: {
            rp: { id: request.rpId, name: "Manut AI" },
            user: { id: own(new TextEncoder().encode(request.userId)), name: request.label, displayName: request.label },
            challenge: own(request.challenge),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
            attestation: "none",
            timeout: 120_000,
          },
        });
      } catch (error) {
        throw failure(error);
      }
      const response = (credential as PublicKeyCredential | null)?.response as AuthenticatorAttestationResponse | undefined;
      if (!credential || !response || typeof response.getAuthenticatorData !== "function") throw new PasskeyFailed();
      return {
        credentialId: bytes((credential as PublicKeyCredential).rawId),
        clientDataJSON: bytes(response.clientDataJSON),
        authenticatorData: bytes(response.getAuthenticatorData()),
      };
    },
    get: async (request) => {
      if (!available) throw new PasskeyFailed();
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.get({
          publicKey: {
            rpId: request.rpId,
            challenge: own(request.challenge),
            allowCredentials: [{ type: "public-key", id: own(request.credentialId) }],
            userVerification: "required",
            timeout: 60_000,
          },
        });
      } catch (error) {
        throw failure(error);
      }
      const response = (credential as PublicKeyCredential | null)?.response as AuthenticatorAssertionResponse | undefined;
      if (!credential || !response) throw new PasskeyFailed();
      return {
        credentialId: bytes((credential as PublicKeyCredential).rawId),
        clientDataJSON: bytes(response.clientDataJSON),
        authenticatorData: bytes(response.authenticatorData),
        signature: bytes(response.signature),
      };
    },
  };
}
