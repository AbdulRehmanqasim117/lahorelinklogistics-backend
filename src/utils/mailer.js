const https = require('https');
const CLIENT_URL =
  (process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://lahorelinklogistics.com')
    .replace(/\/$/, '');

// Read SMTP configuration from environment variables
// Example (for Gmail with App Password):
// SMTP_HOST=smtp.gmail.com
// SMTP_PORT=465
// SMTP_SECURE=true
// SMTP_USER=your_gmail@example.com
// SMTP_PASS=your_app_password
// FROM_NAME=LahoreLink Logistics
// FROM_EMAIL=your_gmail@example.com

const getEmailJsConfig = () => {
  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_ID_RESET;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;

  if (!serviceId || !templateId || !publicKey) {
    console.warn('[MAILER] EmailJS is not fully configured. Email sending is disabled.', {
      hasServiceId: !!serviceId,
      hasTemplateId: !!templateId,
      hasPublicKey: !!publicKey,
    });
    return null;
  }

  return {
    serviceId,
    templateId,
    publicKey,
    privateKey,
  };
};

function sendWithEmailJs({ to, name, code }) {
  const config = getEmailJsConfig();
  if (!config) {
    return null;
  }

  const fromName = process.env.FROM_NAME || 'LahoreLink Logistics';
  const fromEmail = process.env.FROM_EMAIL || 'no-reply@lahorelinklogistics.com';

  const payload = JSON.stringify({
    service_id: config.serviceId,
    template_id: config.templateId,
    user_id: config.publicKey,
    accessToken: config.privateKey,
    template_params: {
      to_email: to,
      to_name: name || 'User',
      reset_code: code,
      from_name: fromName,
      from_email: fromEmail,
    },
  });

  const options = {
    hostname: 'api.emailjs.com',
    path: '/api/v1.0/email/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body });
        } else {
          reject(
            new Error(
              `EmailJS request failed with status ${res.statusCode}: ${body}`
            )
          );
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

async function sendResetEmail(email, code, name) {
  try {
    if (!getEmailJsConfig()) {
      console.error(
        '[MAILER] sendResetEmail called but EmailJS is not configured.'
      );
      throw new Error('Email service is not configured on the server');
    }

    console.log('[MAILER] Sending password reset email via EmailJS', {
      to: email,
    });

    const info = await sendWithEmailJs({ to: email, name, code });

    console.log('[MAILER] Password reset email sent via EmailJS', {
      to: email,
      info,
    });

    return info;
  } catch (error) {
    console.error('❌ Error sending password reset email via EmailJS:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
    });
    throw new Error('Failed to send password reset email: ' + error.message);
  }
}

module.exports = { sendResetEmail };
