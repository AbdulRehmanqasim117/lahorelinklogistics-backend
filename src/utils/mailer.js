const https = require('https');
const nodemailer = require('nodemailer');
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
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !port || !user || !pass) {
      console.error(
        '[MAILER] sendResetEmail called but SMTP is not fully configured.',
        {
          hasHost: !!host,
          hasPort: !!port,
          hasUser: !!user,
          hasPass: !!pass,
        }
      );
      throw new Error('SMTP email service is not configured on the server');
    }

    const fromName = process.env.FROM_NAME || 'LahoreLink Logistics';
    const fromEmail = process.env.FROM_EMAIL || user;

    const secure =
      String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ||
      String(port) === '465';

    const transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure,
      auth: {
        user,
        pass,
      },
    });

    console.log('[MAILER] Sending password reset email via SMTP', {
      to: email,
      host,
      port: Number(port),
      secure,
    });

    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: 'LahoreLink Logistics - Password Reset Code',
      text: `Your LahoreLink Logistics verification code is ${code}. This code will expire in 10 minutes.`,
      html: `<p>Hi ${name || 'User'},</p>
<p>Your LahoreLink Logistics password reset verification code is:</p>
<h2>${code}</h2>
<p>This code will expire in 10 minutes.</p>
<p>If you did not request this, you can safely ignore this email.</p>`,
    });

    console.log('[MAILER] Password reset email sent via SMTP', {
      to: email,
      messageId: info.messageId,
    });

    return info;
  } catch (error) {
    console.error('❌ Error sending password reset email via SMTP:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
    });
    throw new Error('Failed to send password reset email: ' + error.message);
  }
}

module.exports = { sendResetEmail };
