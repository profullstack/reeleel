export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Identifies the transport in logs and in `doctor`-style output. */
  readonly name: string;
  readonly configured: boolean;
  send(message: EmailMessage): Promise<void>;
}

export interface EmailConfig {
  apiKey: string | null;
  from: string;
  /** Absolute base for links in emails, e.g. https://reeleel.com */
  publicUrl: string | null;
}

export const readEmailConfig = (env: NodeJS.ProcessEnv = process.env): EmailConfig => {
  const apiKey = env['RESEND_API_KEY'];
  const publicUrl = env['REELEEL_PUBLIC_URL'];
  return {
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : null,
    from: env['REELEEL_EMAIL_FROM'] ?? 'ReelEel <onboarding@resend.dev>',
    publicUrl: publicUrl !== undefined && publicUrl.length > 0 ? publicUrl.replace(/\/$/, '') : null,
  };
};

/**
 * Writes the message to stderr instead of sending it.
 *
 * This is what runs with no RESEND_API_KEY, and it is a feature rather than a
 * stub: local development and self-hosting should not require an email account,
 * and a verification link printed to the log is enough to finish the flow.
 */
export class ConsoleMailer implements Mailer {
  readonly name = 'console';
  readonly configured = false;

  send(message: EmailMessage): Promise<void> {
    process.stderr.write(
      `\n--- email (not sent: no RESEND_API_KEY) ---\n` +
        `to:      ${message.to}\n` +
        `subject: ${message.subject}\n\n${message.text}\n` +
        `-------------------------------------------\n\n`,
    );
    return Promise.resolve();
  }
}

export class ResendMailer implements Mailer {
  readonly name = 'resend';
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // Surface the provider's reason; a silent failure here means a user
      // never receives a verification link and cannot tell why.
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend rejected the message (${response.status}): ${detail.slice(0, 300)}`);
    }
  }
}

export const createMailer = (config: EmailConfig = readEmailConfig()): Mailer =>
  config.apiKey === null ? new ConsoleMailer() : new ResendMailer(config.apiKey, config.from);

/** Absolute base URL for links, preferring explicit config over the request. */
export const baseUrl = (config: EmailConfig, requestUrl: string): string => {
  if (config.publicUrl !== null) return config.publicUrl;
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
};

export const verificationEmail = (link: string): Omit<EmailMessage, 'to'> => ({
  subject: 'Confirm your ReelEel email',
  text: [
    'Welcome to ReelEel.',
    '',
    'Confirm this address to finish setting up your account:',
    link,
    '',
    'The link expires in 24 hours.',
    '',
    'If you did not create a ReelEel account, ignore this email — nothing will happen.',
  ].join('\n'),
});

export const resetEmail = (link: string): Omit<EmailMessage, 'to'> => ({
  subject: 'Reset your ReelEel password',
  text: [
    'Someone asked to reset the password for this ReelEel account.',
    '',
    'Set a new password:',
    link,
    '',
    'The link expires in 1 hour and can only be used once.',
    '',
    'If this was not you, ignore this email. Your password has not changed.',
  ].join('\n'),
});
