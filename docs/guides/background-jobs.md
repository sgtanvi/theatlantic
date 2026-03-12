# Background Jobs

Scheduled tasks that run outside the request/response cycle for The Atlantic Referral Program.

---

## Trial Expiration Job

### Purpose

Automatically transitions trial subscriptions from `status = 'trial'` to `status = 'expired'` when their `trial_end_date` passes. Without this job, expired trials remain in the `trial` state indefinitely.

### Schedule

**Daily at 2:00 AM UTC** (during low-traffic window).

### What it does

1. Finds all trial subscriptions past their `trial_end_date`
2. Sets `status = 'expired'` and `end_date = trial_end_date`
3. Writes a `subscription_history` record for each (`reason = 'trial_expired'`)
4. Logs how many trials were expired

### SQL

```sql
-- Expire trials that have passed their trial_end_date
UPDATE subscriptions
SET
    status = 'expired',
    end_date = trial_end_date,
    updated_at = CURRENT_TIMESTAMP
WHERE
    status = 'trial'
    AND is_trial = TRUE
    AND trial_end_date < CURRENT_TIMESTAMP
RETURNING id, user_id, trial_end_date;
```

### Implementation (Node.js + node-cron)

```javascript
// src/jobs/expireTrials.js
const cron = require('node-cron');
const pool = require('../config/database');

async function runExpireTrials() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Expire eligible trials
    const result = await client.query(`
      UPDATE subscriptions
      SET
        status = 'expired',
        end_date = trial_end_date,
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'trial'
        AND is_trial = TRUE
        AND trial_end_date < CURRENT_TIMESTAMP
      RETURNING id, user_id
    `);

    // Write audit history for each expired trial
    for (const sub of result.rows) {
      await client.query(
        `INSERT INTO subscription_history
           (subscription_id, user_id, previous_status, new_status, reason)
         VALUES ($1, $2, 'trial', 'expired', 'trial_expired')`,
        [sub.id, sub.user_id]
      );
    }

    await client.query('COMMIT');

    console.log(`[expireTrials] Expired ${result.rows.length} trials`);
    return result.rows.length;

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[expireTrials] Job failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Schedule: daily at 2:00 AM UTC
cron.schedule('0 2 * * *', () => {
  console.log('[expireTrials] Starting scheduled run...');
  runExpireTrials().catch(err => {
    console.error('[expireTrials] Unhandled error:', err);
  });
});

module.exports = { runExpireTrials };
```

Register the job in `src/server.js`:

```javascript
// Only run scheduled jobs in production/staging, not during tests
if (process.env.NODE_ENV !== 'test') {
  require('./jobs/expireTrials');
}
```

### Manual trigger (for testing)

```bash
node -e "require('./src/jobs/expireTrials').runExpireTrials().then(n => console.log('Expired:', n))"
```

### Interaction with eligibility

Once a trial expires, the user's `subscriptions` row has `status = 'expired'` and `end_date = trial_end_date`. This means:

- **Rule 1** of `is_user_eligible_for_trial`: no longer blocked (not `status = 'active'`)
- **Rule 2**: blocked for 12 months from `end_date` (subscription cooldown)
- **Rule 3**: blocked for 24 months from `start_date` (trial cooldown)

An expired trial user typically becomes eligible again ~24 months after their trial started.

### Idempotency

The `UPDATE ... WHERE status = 'trial' AND trial_end_date < NOW()` pattern is idempotent — running it twice has the same effect as running it once because already-expired rows are no longer `status = 'trial'`.

### Monitoring

- Log count of expired trials each run
- Alert if the job throws (via process error handler or monitoring tool)
- Track `subscription_history` counts with `reason = 'trial_expired'` to confirm job is running

### Future: email notifications

When email sending is added, the job should notify users their trial has expired:

```javascript
// TODO: add after EmailService is implemented
// await EmailService.sendTrialExpiredNotification(sub.user_id);
```

---

## Future Jobs (v3+)

| Job | Trigger | Purpose |
|-----|---------|---------|
| Pass expiration cleanup | Weekly | Mark passes with `expires_at` in the past as expired (informational) |
| Win-back campaign | Monthly | Identify users newly eligible for win-back (lapsed 12+ months) |
| Referral stats rollup | Daily | Precompute analytics if `user_available_passes` view becomes slow |
