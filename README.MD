# The Atlantic Referral Program - Documentation

> **Version**: 2.0  
> **Last Updated**: March 2026  
> **Status**: Design Complete, Implementation Pending

## Documentation Overview

This documentation provides a complete architectural design for The Atlantic's referral program, where active subscribers can share 3 passes that grant 7-day free digital trials to new users.

---

## Documentation Structure

```
docs/
├── api/                    # API specifications and contracts
│   ├── endpoints.md        # Complete REST API reference
│   ├── authentication.md   # Auth strategy and implementation
│   ├── errors.md          # Error codes and handling
│   └── examples.md        # Request/response examples
│
├── database/              # Database design and schema
│   ├── schema.md          # Complete schema with rationale
│   ├── functions.md       # PostgreSQL functions
│   ├── triggers.md        # Database triggers
│   └── migrations.md      # v1→v2 migration guide
│
├── architecture/          # System architecture
│   ├── overview.md        # High-level system design
│   ├── data-model.md      # Data modeling decisions
│   ├── edge-cases.md      # Edge case analysis (14 scenarios)
│   └── security.md        # Security model and measures
│
└── guides/                # Implementation and usage guides
    ├── getting-started.md # Setup and installation
    ├── implementation.md  # Implementation roadmap
    ├── testing.md         # Testing strategy
    └── deployment.md      # Production deployment guide
```

---

## Quick Start

**New to this project?** Start here:

1. **[Architecture Overview](architecture/overview.md)** - Understand the system design
2. **[Data Model](architecture/data-model.md)** - Core tables and relationships
3. **[API Endpoints](api/endpoints.md)** - REST API specifications
4. **[Edge Cases](architecture/edge-cases.md)** - Security and business logic

**Ready to implement?** Follow this path:

1. **[Database Schema](database/schema.md)** - Set up PostgreSQL
2. **[Getting Started Guide](guides/getting-started.md)** - Local development setup
3. **[Implementation Guide](guides/implementation.md)** - Build the API
4. **[Testing Guide](guides/testing.md)** - Validate your implementation

---

## Key Documents

### For Product/Business
- **[Architecture Overview](architecture/overview.md)** - Business logic and user flows
- **[Edge Cases](architecture/edge-cases.md)** - How we handle abuse and errors
- **[CHANGELOG](../CHANGELOG.md)** - v2 improvements and business impact

### For Engineers
- **[Database Schema](database/schema.md)** - Complete table definitions
- **[API Endpoints](api/endpoints.md)** - REST API contracts
- **[Implementation Guide](guides/implementation.md)** - Step-by-step build instructions

### For Security/Compliance
- **[Security Model](architecture/security.md)** - JWT, transactions, email normalization
- **[Edge Cases](architecture/edge-cases.md)** - Attack vectors and mitigations
- **[Error Handling](api/errors.md)** - Proper status codes and messages

---

## What This System Does

### User Journey

**For Referrers (Active Subscribers)**:
1. Get 3 shareable passes automatically when subscription activates
2. Each pass is a unique, secure JWT token link
3. Share passes with friends via email, text, social media
4. Track redemptions and see who used your passes

**For Recipients (New Users)**:
1. Click referral link from friend
2. System validates eligibility (no active/recent subscriptions)
3. Receive 7-day free digital trial instantly
4. Can convert to paid subscription anytime

**For The Atlantic**:
1. Viral growth through word-of-mouth
2. High-quality leads (referred by engaged readers)
3. Protected revenue (abuse prevention via email normalization)
4. Win-back opportunity (re-engage lapsed subscribers)

---

## v2 Highlights

**Critical Security Fix**:
- Email normalization prevents infinite trial abuse via Gmail +aliases
- See [Security Model](architecture/security.md) for details

**Business Improvement**:
- Cooldown periods (12mo/24mo) enable win-back marketing
- Estimated +$114K-210K annual revenue impact
- See [CHANGELOG](../CHANGELOG.md) for full analysis

**Performance**:
- Optimized database triggers (~40% faster on large tables)
- See [Database Triggers](database/triggers.md)

---

## Architecture at a Glance

```
┌─────────────┐
│   Client    │ (Web/Mobile)
└──────┬──────┘
       │ HTTPS
       ▼
┌─────────────────────────────────┐
│      REST API Endpoints         │
│  ┌─────────────────────────┐   │
│  │ GET  /api/referral/passes│   │
│  │ POST /api/referral/redeem│   │
│  │ GET  /api/referral/stats │   │
│  └─────────────────────────┘   │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│      Business Logic Layer       │
│  ┌──────────────────────────┐  │
│  │ Eligibility Checks       │  │
│  │ Email Normalization      │  │
│  │ JWT Token Verification   │  │
│  │ Transaction Management   │  │
│  └──────────────────────────┘  │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│      PostgreSQL Database        │
│  ┌──────────────────────────┐  │
│  │ users                    │  │
│  │ subscriptions            │  │
│  │ referral_passes          │  │
│  │ subscription_history     │  │
│  └──────────────────────────┘  │
│                                 │
│  Triggers: Auto-generate passes │
│  Functions: Eligibility checks  │
│  Constraints: Data integrity    │
└─────────────────────────────────┘
```

---

## Key Metrics

**Scale Considerations**:
- 1M active subscribers → 3M referral passes
- 100K monthly redemptions (10% conversion)
- ~300MB storage for pass records
- <250ms average redemption latency

**Business Projections**:
- 15% of lapsed users eligible for win-back (v2)
- 3-5% win-back conversion rate
- 5-10% abuse rate prevented by email normalization
- +$114K-210K annual revenue impact (v2)

---

## Related Resources

- **[README](../README.md)** - Quick summary and key decisions
- **[CHANGELOG](../CHANGELOG.md)** - Version history and migration guide
- **[Original Design Doc](../DESIGN_DOC.md)** - Comprehensive 60-page reference

---

## Contributing

This is a design document, not implemented code. To implement:

1. Review [Getting Started](guides/getting-started.md)
2. Follow [Implementation Guide](guides/implementation.md)
3. Reference [API Specs](api/endpoints.md) and [Database Schema](database/schema.md)
4. Run tests per [Testing Guide](guides/testing.md)

---

## Support

**Questions about the design?**
- Check [Architecture Overview](architecture/overview.md) for high-level explanations
- Review [Edge Cases](architecture/edge-cases.md) for specific scenarios
- See [API Examples](api/examples.md) for usage patterns

**Found an issue?**
- Security concerns → Review [Security Model](architecture/security.md)
- Business logic questions → See [Data Model](architecture/data-model.md)
- Implementation blockers → Check [Implementation Guide](guides/implementation.md)

---

## License

This design document was created as part of The Atlantic take-home assessment.

---

**Version**: 2.0  
**Design Time**: 3.5 hours  
**Pages**: 60+ across all documentation  
**Edge Cases**: 14 scenarios documented and handled