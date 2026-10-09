'use strict';

const nodemailer = require('nodemailer');

// Envío de correos de la plataforma (recuperación de contraseña y pruebas).
// Se configura con variables de entorno; sin ellas, en desarrollo el enlace se muestra en la consola.

function mailConfigFromEnv(env) {
  const port = Number(env.SMTP_PORT || 465);
  return {
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.MAIL_FROM || env.SMTP_USER
  };
}

function createMailer(env = process.env) {
  const config = mailConfigFromEnv(env);
  const configured = Boolean(config.host && config.user && config.password);
  const transport = configured
    ? nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    })
    : null;

  return {
    configured,
    from: configured ? config.from : null,
    async send({ to, subject, html, text, attachments }) {
      if (!transport) {
        if (env.NODE_ENV !== 'production') {
          console.log(`[correo no configurado] Para: ${to}\nAsunto: ${subject}\n${text}`);
          return { delivered: false, reason: 'not_configured' };
        }
        const error = new Error('El correo de la plataforma no está configurado');
        error.code = 'MAIL_NOT_CONFIGURED';
        throw error;
      }
      const info = await transport.sendMail({ from: config.from, to, subject, html, text, ...(attachments ? { attachments } : {}) });
      return { delivered: true, id: info.messageId };
    },
    async verify() {
      if (!transport) return false;
      await transport.verify();
      return true;
    }
  };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);

// Correo con el enlace para crear una nueva contraseña.
function passwordResetEmail({ name, link, agencyName, minutes }) {
  const agency = agencyName || 'Viajes Casal';
  const subject = `Crea tu nueva contraseña · ${agency}`;
  const text = [
    `Hola ${name},`,
    '',
    `Recibimos una solicitud para cambiar la contraseña de tu acceso a la plataforma de ${agency}.`,
    `Abre este enlace para crear una nueva (vence en ${minutes} minutos y solo funciona una vez):`,
    link,
    '',
    'Si no la solicitaste, ignora este correo: tu contraseña actual sigue funcionando.'
  ].join('\n');
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f7f9;font-family:Arial,Helvetica,sans-serif;color:#203342">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f9;padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden">
      <tr><td style="background:#073b66;padding:22px 28px;color:#ffffff;font-size:13px;letter-spacing:2px;font-weight:bold">${escapeHtml(agency.toUpperCase())}</td></tr>
      <tr><td style="padding:28px">
        <h1 style="margin:0 0 14px;font-size:22px;color:#073b66">Crea tu nueva contraseña</h1>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.5">Hola ${escapeHtml(name)}, recibimos una solicitud para cambiar la contraseña de tu acceso a la plataforma.</p>
        <p style="margin:24px 0;text-align:center"><a href="${escapeHtml(link)}" style="background:#00b8c8;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:10px;display:inline-block">Crear nueva contraseña</a></p>
        <p style="margin:0 0 10px;font-size:13px;color:#6c7b87;line-height:1.5">El enlace vence en ${minutes} minutos y solo funciona una vez. Si el botón no abre, copia esta dirección en tu navegador:</p>
        <p style="margin:0 0 18px;font-size:12px;word-break:break-all;color:#0b86b4">${escapeHtml(link)}</p>
        <p style="margin:0;font-size:13px;color:#6c7b87;line-height:1.5">Si no lo solicitaste, ignora este correo. Tu contraseña actual sigue funcionando.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  return { subject, text, html };
}

// Código de 6 dígitos para la verificación en dos pasos.
function twofaCodeEmail({ name, code, agencyName, minutes }) {
  const agency = agencyName || 'Viajes Casal';
  const subject = `${code} es tu código de acceso · ${agency}`;
  const text = [
    `Hola ${name},`,
    '',
    `Tu código para entrar a la plataforma de ${agency} es: ${code}`,
    `Vence en ${minutes} minutos.`,
    '',
    'Si no estabas iniciando sesión, cambia tu contraseña: alguien la conoce.'
  ].join('\n');
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f7f9;font-family:Arial,Helvetica,sans-serif;color:#203342">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f9;padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden">
      <tr><td style="background:#073b66;padding:22px 28px;color:#ffffff;font-size:13px;letter-spacing:2px;font-weight:bold">${escapeHtml(agency.toUpperCase())}</td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 14px;font-size:15px">Hola ${escapeHtml(name)}, este es tu código para entrar a la plataforma:</p>
        <p style="margin:18px 0;text-align:center;font-size:34px;letter-spacing:10px;font-weight:bold;color:#073b66;font-family:Consolas,Menlo,monospace">${escapeHtml(code)}</p>
        <p style="margin:0 0 10px;font-size:13px;color:#6c7b87">Vence en ${minutes} minutos.</p>
        <p style="margin:0;font-size:13px;color:#6c7b87">Si no estabas iniciando sesión, cambia tu contraseña: alguien la conoce.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  return { subject, text, html };
}

function testEmail({ name, agencyName, appUrl }) {
  const agency = agencyName || 'Viajes Casal';
  const subject = `Correo de prueba · ${agency}`;
  const text = `Hola ${name}, este es un correo de prueba de la plataforma de ${agency}. Si lo recibiste, la recuperación de contraseñas ya puede enviar enlaces.\nDirección de la plataforma: ${appUrl}`;
  const html = `<p style="font-family:Arial,sans-serif;font-size:15px;color:#203342">Hola ${escapeHtml(name)}, este es un correo de prueba de la plataforma de <b>${escapeHtml(agency)}</b>.</p><p style="font-family:Arial,sans-serif;font-size:15px;color:#203342">Si lo recibiste, la recuperación de contraseñas ya puede enviar enlaces.</p><p style="font-family:Arial,sans-serif;font-size:13px;color:#6c7b87">Dirección de la plataforma: ${escapeHtml(appUrl)}</p>`;
  return { subject, text, html };
}

module.exports = { createMailer, mailConfigFromEnv, passwordResetEmail, twofaCodeEmail, testEmail };
