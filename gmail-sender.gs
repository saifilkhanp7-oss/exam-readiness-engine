/**
 * Exam Readiness Engine — Gmail sender
 *
 * Paste this whole file into a new project at https://script.google.com
 * (signed in to the Gmail account that should send the login codes),
 * then deploy it as a Web app. Full steps are in the README under "Email login".
 *
 * Change SECRET below to your own long random text, and put the SAME text
 * in Railway as the variable GMAIL_SCRIPT_SECRET.
 */
const SECRET = 'CHANGE-ME-to-a-long-random-secret';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (!d || d.secret !== SECRET) return reply({ ok: false, error: 'wrong secret' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.to || '')) return reply({ ok: false, error: 'bad address' });
    MailApp.sendEmail({
      to: d.to,
      subject: String(d.subject || 'Your Exam Readiness Engine code').slice(0, 200),
      body: String(d.text || ''),
      htmlBody: String(d.html || ''),
      name: d.name || 'Exam Readiness Engine',
    });
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor (select testSend → Run) to give the script permission to send mail. */
function testSend() {
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Exam Readiness Engine test', 'The Exam Readiness Engine Gmail sender works.');
}
