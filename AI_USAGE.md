# Human and AI contributions

The requester supplied the interview prompt, reviewed the proposed scope and asked for a working implementation. They set the design reference, requested the removal of seeded data and asked for direct Instagram integration. They chose to publish this repository for review and requested the external API and Swagger documentation.

AI developed the system design, TypeScript application, PostgreSQL schema, operator console, test suite and documentation. Codex performed the follow-up code and design reviews, implemented corrections and ran the verification. The requester did not claim to have hand-written the implementation.

The tests distinguish behavior exercised on PostgreSQL, Temporal and HTTP transports from behavior that needs an authorized external account. The callback challenge was separately verified in the Meta developer dashboard with a temporary HTTPS endpoint. Comment and message subscriptions were off, and the endpoint was removed after verification. A live account-to-DM journey remains unverified.
