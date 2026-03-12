/**
 * Unit tests: normalizeEmail()
 *
 * Mirrors tests/database/functions.test.js normalize_email() suite so the
 * JavaScript utility stays in sync with the PostgreSQL function.
 *
 * Spec: docs/database/functions.md — normalize_email()
 */

const { normalizeEmail } = require('../../../src/utils/email');

// ===========================================================================
// Gmail
// ===========================================================================

describe('normalizeEmail() — Gmail', () => {
  it('strips +alias', () => {
    expect(normalizeEmail('user+1@gmail.com')).toBe('user@gmail.com');
  });

  it('removes dots from local part', () => {
    expect(normalizeEmail('john.doe@gmail.com')).toBe('johndoe@gmail.com');
  });

  it('lowercases the address and strips +alias', () => {
    expect(normalizeEmail('User+Test@Gmail.com')).toBe('user@gmail.com');
  });

  it('normalizes googlemail.com domain to gmail.com', () => {
    expect(normalizeEmail('John.Doe@Googlemail.com')).toBe('johndoe@gmail.com');
  });

  it('handles both dots and +alias together', () => {
    expect(normalizeEmail('john.doe+atlantic@gmail.com')).toBe('johndoe@gmail.com');
  });
});

// ===========================================================================
// Outlook / Hotmail / Live
// ===========================================================================

describe('normalizeEmail() — Outlook', () => {
  it('strips +alias on outlook.com', () => {
    expect(normalizeEmail('user+alias@outlook.com')).toBe('user@outlook.com');
  });

  it('strips +alias on hotmail.com', () => {
    expect(normalizeEmail('user+trial@hotmail.com')).toBe('user@hotmail.com');
  });

  it('strips +alias on live.com', () => {
    expect(normalizeEmail('user+promo@live.com')).toBe('user@live.com');
  });
});

// ===========================================================================
// Yahoo
// ===========================================================================

describe('normalizeEmail() — Yahoo', () => {
  it('strips -alias (Yahoo uses hyphens)', () => {
    expect(normalizeEmail('user-test@yahoo.com')).toBe('user@yahoo.com');
  });
});

// ===========================================================================
// ProtonMail
// ===========================================================================

describe('normalizeEmail() — ProtonMail', () => {
  it('strips +alias on protonmail.com', () => {
    expect(normalizeEmail('user+alias@protonmail.com')).toBe('user@protonmail.com');
  });

  it('strips +alias on proton.me', () => {
    expect(normalizeEmail('name+promo@proton.me')).toBe('name@proton.me');
  });

  it('strips +alias on pm.me', () => {
    expect(normalizeEmail('user+trial@pm.me')).toBe('user@pm.me');
  });
});

// ===========================================================================
// Generic / other providers
// ===========================================================================

describe('normalizeEmail() — other providers', () => {
  it('strips +alias for unknown providers', () => {
    expect(normalizeEmail('person+anything@example.com')).toBe('person@example.com');
  });

  it('lowercases the entire address', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
  });

  it('preserves dots for non-Gmail providers', () => {
    // Dots are only stripped for Gmail — other providers keep them
    expect(normalizeEmail('john.doe@example.com')).toBe('john.doe@example.com');
  });
});
