# Project Structure

> Recommended file organization for implementing The Atlantic Referral Program

## Recommended Directory Structure

```
atlantic-referral/
├── docs/                          # Documentation (you are here)
│   ├── README.md                  # Documentation index
│   ├── api/                       # API specifications
│   │   ├── endpoints.md           # REST API reference
│   │   ├── authentication.md      # Auth implementation
│   │   ├── errors.md             # Error codes and handling
│   │   └── examples.md           # Request/response examples
│   ├── database/                  # Database design
│   │   ├── schema.md             # Complete schema
│   │   ├── functions.md          # PostgreSQL functions
│   │   ├── triggers.md           # Database triggers
│   │   └── migrations.md         # Migration guide
│   ├── architecture/              # System design
│   │   ├── overview.md           # High-level architecture
│   │   ├── data-model.md         # Data modeling decisions
│   │   ├── edge-cases.md         # Edge case analysis
│   │   └── security.md           # Security model
│   └── guides/                    # Implementation guides
│       ├── getting-started.md    # Setup instructions
│       ├── implementation.md     # Build guide
│       ├── testing.md            # Test strategy
│       └── deployment.md         # Production deployment
│
├── src/                           # Application source code
│   ├── server.js                 # Express app entry point
│   ├── config/                   # Configuration
│   │   ├── database.js           # Database connection
│   │   ├── jwt.js                # JWT secret management
│   │   └── environment.js        # Environment variables
│   ├── models/                   # Data models
│   │   ├── User.js               # User model
│   │   ├── Subscription.js       # Subscription model
│   │   ├── ReferralPass.js       # Referral pass model
│   │   └── SubscriptionHistory.js
│   ├── services/                 # Business logic
│   │   ├── ReferralService.js    # Pass generation, redemption
│   │   ├── SubscriptionService.js # Subscription management
│   │   ├── EmailService.js       # Email normalization
│   │   └── AuthService.js        # Authentication
│   ├── controllers/              # Route handlers
│   │   ├── referralController.js # Referral endpoints
│   │   └── subscriptionController.js
│   ├── middleware/               # Express middleware
│   │   ├── auth.js               # Authentication
│   │   ├── validation.js         # Request validation
│   │   ├── errorHandler.js       # Error handling
│   │   └── rateLimiter.js        # Rate limiting (v3)
│   ├── routes/                   # Route definitions
│   │   ├── index.js              # Route aggregation
│   │   ├── referral.js           # /api/referral/*
│   │   └── subscription.js       # /api/subscriptions/*
│   └── utils/                    # Utility functions
│       ├── jwt.js                # JWT generation/verification
│       ├── database.js           # Query helpers
│       └── validators.js         # Input validation
│
├── database/                      # Database scripts
│   ├── schema.sql                # Complete schema (v2)
│   ├── seed.sql                  # Sample data for development
│   ├── migrations/               # Schema changes
│   │   ├── 001_initial_schema.sql
│   │   └── 002_add_email_normalization.sql
│   └── functions/                # Separate function files
│       ├── normalize_email.sql
│       ├── is_user_eligible_for_trial.sql
│       └── generate_referral_passes.sql
│
├── tests/                         # Test suite
│   ├── unit/                     # Unit tests
│   │   ├── services/
│   │   │   ├── ReferralService.test.js
│   │   │   └── EmailService.test.js
│   │   └── utils/
│   │       └── jwt.test.js
│   ├── integration/              # Integration tests
│   │   ├── api/
│   │   │   ├── referral.test.js
│   │   │   └── subscription.test.js
│   │   └── database/
│   │       └── triggers.test.js
│   └── e2e/                      # End-to-end tests
│       └── redemption-flow.test.js
│
├── scripts/                       # Utility scripts
│   ├── setup-db.sh               # Database setup
│   ├── seed-dev-data.sh          # Load sample data
│   ├── generate-jwt-secret.js    # Generate secure secret
│   └── migrate.js                # Run migrations
│
├── .env.example                   # Environment template
├── .gitignore                    # Git ignore rules
├── package.json                  # Node.js dependencies
├── README.md                     # Project overview
├── CHANGELOG.md                  # Version history
└── DESIGN_DOC.md                 # Complete design (60 pages)
```

---

## File Responsibilities

### `/src/server.js`
**Purpose**: Express app entry point

```javascript
const express = require('express');
const routes = require('./routes');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(express.json());
app.use('/api', routes);
app.use(errorHandler);

app.listen(3000, () => console.log('Server running on port 3000'));
```

---

### `/src/config/database.js`
**Purpose**: PostgreSQL connection pool

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  max: 20, // connection pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

module.exports = pool;
```

---

### `/src/services/ReferralService.js`
**Purpose**: Referral business logic

**Methods**:
- `getUserPasses(userId)` - Get all passes
- `getPassLink(passId, userId)` - Get shareable link
- `redeemPass(token, recipientUserId)` - Redeem pass
- `checkEligibility(userId)` - Check trial eligibility
- `getReferralStats(userId)` - Get analytics

**Example**:
```javascript
class ReferralService {
  static async redeemPass(token, recipientUserId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // 1. Verify JWT
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // 2. Get pass from DB
      const pass = await client.query('SELECT ...');
      
      // 3-11. Validation + creation
      // ...
      
      await client.query('COMMIT');
      return subscription;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
```

---

### `/src/services/EmailService.js`
**Purpose**: Email normalization logic

```javascript
class EmailService {
  static normalize(email) {
    // Apply same logic as PostgreSQL normalize_email() function
    // For consistency testing
  }
}
```

---

### `/src/controllers/referralController.js`
**Purpose**: HTTP request/response handling

```javascript
exports.getPasses = async (req, res, next) => {
  try {
    const passes = await ReferralService.getUserPasses(req.user.id);
    res.json({ success: true, data: passes });
  } catch (error) {
    next(error);
  }
};

exports.redeemPass = async (req, res, next) => {
  try {
    const { token } = req.body;
    const subscription = await ReferralService.redeemPass(token, req.user.id);
    res.status(201).json({
      success: true,
      message: '7-day trial activated successfully!',
      data: subscription
    });
  } catch (error) {
    next(error);
  }
};
```

---

### `/src/middleware/auth.js`
**Purpose**: Authentication middleware

```javascript
async function authenticateUser(req, res, next) {
  const userId = req.headers['x-user-id']; // Development
  // const userId = req.session?.userId; // Production
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Authentication required'
    });
  }
  
  const user = await User.findById(userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'User not found'
    });
  }
  
  req.user = user;
  next();
}
```

---

### `/src/middleware/errorHandler.js`
**Purpose**: Centralized error handling

```javascript
function errorHandler(err, req, res, next) {
  console.error('Error:', err);
  
  // Map errors to HTTP status codes
  const statusCode = err.status || 500;
  const error = err.error || 'Internal server error';
  const message = process.env.NODE_ENV === 'development'
    ? err.message
    : 'An unexpected error occurred';
  
  res.status(statusCode).json({
    success: false,
    error,
    message
  });
}
```

---

### `/src/routes/referral.js`
**Purpose**: Referral endpoint routing

```javascript
const express = require('express');
const router = express.Router();
const controller = require('../controllers/referralController');
const auth = require('../middleware/auth');

router.get('/passes', auth, controller.getPasses);
router.get('/passes/:id/link', auth, controller.getPassLink);
router.post('/redeem', auth, controller.redeemPass);
router.get('/eligibility', auth, controller.checkEligibility);
router.get('/stats', auth, controller.getReferralStats);

module.exports = router;
```

---

## Database Files

### `/database/schema.sql`
**Purpose**: Complete database schema (single file for easy setup)

Includes:
- Table definitions
- Indexes
- Constraints
- Functions
- Triggers
- Views
- Sample data

---

### `/database/migrations/`
**Purpose**: Version-controlled schema changes

**Naming**: `NNN_description.sql`

Example:
```
001_initial_schema.sql       # v1.0: Initial tables
002_add_email_normalization.sql  # v2.0: Email normalization
003_add_rate_limiting.sql    # v3.0: Rate limit tracking
```

Each migration is idempotent (can run multiple times safely).

---

## Test Organization

### Unit Tests
Test individual functions in isolation

```javascript
// tests/unit/services/EmailService.test.js
describe('EmailService.normalize', () => {
  it('should normalize Gmail +alias', () => {
    expect(EmailService.normalize('user+1@gmail.com'))
      .toBe('user@gmail.com');
  });
  
  it('should remove Gmail dots', () => {
    expect(EmailService.normalize('john.doe@gmail.com'))
      .toBe('johndoe@gmail.com');
  });
});
```

### Integration Tests
Test API endpoints end-to-end

```javascript
// tests/integration/api/referral.test.js
describe('POST /api/referral/redeem', () => {
  it('should create trial subscription', async () => {
    const token = generateValidToken();
    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', newUserId)
      .send({ token });
    
    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('trial');
  });
  
  it('should reject already redeemed pass', async () => {
    const token = await redeemOnce();
    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', anotherUserId)
      .send({ token });
    
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Pass already redeemed');
  });
});
```

---

## Environment Files

### `.env.example`
Template for required environment variables

```bash
# Database
DB_USER=postgres
DB_HOST=localhost
DB_NAME=atlantic_referral
DB_PASSWORD=your_password_here
DB_PORT=5432

# JWT
JWT_SECRET=your_jwt_secret_here

# Server
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000

# Feature Flags
TRIAL_DURATION_DAYS=7
PASS_EXPIRATION_DAYS=90
```

### `.env` (not committed to git)
Actual values for local development

---

## Scripts

### `/scripts/setup-db.sh`
```bash
#!/bin/bash
psql -U postgres -c "CREATE DATABASE atlantic_referral;"
psql -U postgres -d atlantic_referral -f database/schema.sql
psql -U postgres -d atlantic_referral -f database/seed.sql
echo "✅ Database setup complete"
```

### `/scripts/generate-jwt-secret.js`
```javascript
const crypto = require('crypto');
const secret = crypto.randomBytes(64).toString('hex');
console.log(`JWT_SECRET=${secret}`);
```

---

## Git Ignore

```
# Dependencies
node_modules/

# Environment
.env

# Logs
*.log
npm-debug.log*

# OS
.DS_Store
Thumbs.db

# Editor
.vscode/
.idea/

# Test coverage
coverage/
```

---

## Package.json Scripts

```json
{
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "test": "jest --coverage",
    "test:watch": "jest --watch",
    "test:integration": "jest tests/integration",
    "db:setup": "./scripts/setup-db.sh",
    "db:migrate": "node scripts/migrate.js",
    "db:seed": "psql -U postgres -d atlantic_referral -f database/seed.sql"
  }
}
```

---

## Development Workflow

1. **Setup**:
   ```bash
   npm install
   cp .env.example .env
   # Edit .env with your values
   npm run db:setup
   ```

2. **Development**:
   ```bash
   npm run dev  # Auto-reload on file changes
   ```

3. **Testing**:
   ```bash
   npm test  # All tests
   npm run test:integration  # Just API tests
   ```

4. **Database Changes**:
   ```bash
   # Create migration
   touch database/migrations/003_your_change.sql
   # Run migration
   npm run db:migrate
   ```

---

## Production Structure

Additional files for production:

```
├── ecosystem.config.js    # PM2 process manager
├── nginx.conf            # Nginx reverse proxy
├── Dockerfile            # Container image
├── docker-compose.yml    # Multi-container orchestration
└── .github/
    └── workflows/
        └── deploy.yml    # CI/CD pipeline
```

---

## Next Steps

- [Getting Started](../guides/getting-started.md) - Set up development environment
- [Implementation Guide](../guides/implementation.md) - Build the application
- [Testing Guide](../guides/testing.md) - Write comprehensive tests
- [Deployment Guide](../guides/deployment.md) - Deploy to production