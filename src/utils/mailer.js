const nodemailer = require('nodemailer');
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// Read SMTP configuration from environment variables
// Example (for Gmail with App Password):
// SMTP_HOST=smtp.gmail.com
// SMTP_PORT=465
// SMTP_SECURE=true
// SMTP_USER=your_gmail@example.com
// SMTP_PASS=your_app_password
// FROM_NAME=LahoreLink Logistics
// FROM_EMAIL=your_gmail@example.com

const getSmtpConfig = () => {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn(
      '[MAILER] SMTP_USER or SMTP_PASS not set. Email sending is disabled.'
    );
  }

  return {
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : null,
  };
};

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const config = getSmtpConfig();

  if (!config.auth) {
    transporter = null;
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });

  // Verify connection on startup and log result
  transporter
    .verify()
    .then(() => {
      console.log(
        `[MAILER] SMTP connection verified (${config.host}:${config.port}, secure=${config.secure})`
      );
    })
    .catch((error) => {
      console.error('[MAILER] SMTP verification failed:', {
        message: error.message,
        code: error.code,
        response: error.response,
      });
    });

  return transporter;
}

async function sendResetEmail(email, code, name) {
  const tx = getTransporter();

  if (!tx) {
    console.error(
      '[MAILER] sendResetEmail called but transporter is not configured.'
    );
    throw new Error('Email service is not configured on the server');
  }

  try {
    const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;
    const fromName = process.env.FROM_NAME || 'LahoreLink Logistics';
    const from = fromEmail ? `"${fromName}" <${fromEmail}>` : undefined;

    const subject = 'LahoreLink - Password Reset Code';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">
          <h2 style="color: #2c3e50;">Password Reset Request</h2>
          <p>Hello ${name || 'User'},</p>
          <p>We received a request to reset your password. Use the following verification code:</p>
          
          <div style="text-align: center; margin: 30px 0; background: #fff; padding: 20px; border-radius: 5px; border: 1px dashed #ccc;">
            <div style="font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #2c3e50;">
              ${code}
            </div>
            <div style="margin-top: 10px; font-size: 12px; color: #7f8c8d;">
              (This code is valid for 10 minutes)
            </div>
          </div>
          
          <p>Enter this code in the password reset form to proceed. If you didn't request this, please ignore this email.</p>
          
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 12px; color: #7f8c8d;">
            This is an automated message, please do not reply to this email.
          </p>
        </div>
      </div>
    `;

    // Plain text version for email clients that don't support HTML
    const text = `
      Hello ${name || 'User'},

      Your password reset code is: ${code}
      
      Enter this code in the password reset form to proceed.
      
      This code is valid for 10 minutes.
      
      If you didn't request this, please ignore this email.
    `;

    const mailOptions = {
      from,
      to: email,
      subject,
      html,
      text,
    };

    console.log('[MAILER] Sending password reset email', { to: email });

    const info = await tx.sendMail(mailOptions);

    console.log('[MAILER] Password reset email sent', {
      to: email,
      messageId: info.messageId,
      response: info.response,
    });

    return info;
  } catch (error) {
    console.error('❌ Error sending password reset email:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      response: error.response,
    });
    throw new Error('Failed to send password reset email: ' + error.message);
  }
}

// Initialize transporter on module load so that verify() runs on startup
getTransporter();

module.exports = { sendResetEmail };
