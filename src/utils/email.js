/**
 * Email normalization utility
 *
 * JavaScript mirror of the PostgreSQL normalize_email() function defined in
 * database/schema.sql. Both must produce identical output for the same input —
 * divergence would allow the email-normalization abuse-prevention layer to be
 * bypassed by going through one path but not the other.
 *
 * Provider rules:
 *   Gmail / Googlemail : remove dots, strip +alias, normalize domain to gmail.com
 *   Outlook / Hotmail  : strip +alias
 *   Yahoo              : strip -alias (Yahoo uses hyphens, not +)
 *   ProtonMail         : strip +alias
 *   All others         : strip +alias, preserve dots
 *
 * See docs/database/functions.md for rationale and full example table.
 *
 * @param {string} email - Raw email address from user input
 * @returns {string} Canonical normalized form
 */
function normalizeEmail(email) {
  const atIndex   = email.indexOf('@');
  let localPart   = email.slice(0, atIndex).toLowerCase();
  let domain      = email.slice(atIndex + 1).toLowerCase();

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    // Gmail ignores all dots in the local part
    localPart = localPart.replace(/\./g, '');
    // Strip +alias
    localPart = localPart.split('+')[0];
    // Treat googlemail.com as gmail.com
    domain = 'gmail.com';

  } else if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com') {
    localPart = localPart.split('+')[0];

  } else if (domain === 'yahoo.com') {
    // Yahoo uses hyphens for aliases (e.g. user-alias@yahoo.com)
    localPart = localPart.split('-')[0];

  } else if (domain === 'protonmail.com' || domain === 'proton.me' || domain === 'pm.me') {
    localPart = localPart.split('+')[0];

  } else {
    // Generic: strip +alias for all other providers
    localPart = localPart.split('+')[0];
  }

  return `${localPart}@${domain}`;
}

module.exports = { normalizeEmail };
