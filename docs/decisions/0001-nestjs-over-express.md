# ADR 0001 — NestJS instead of plain Express

**Status:** Accepted

The scope document proposed Express + TypeScript. The backend uses NestJS (which runs on Express) instead.

**Why:** dependency injection makes the API/worker split trivial (two root modules sharing `CoreModule`), first-class BullMQ, Swagger, throttling and validation integrations, and a module structure that maps 1:1 onto the domain areas in the scope.

**Trade-off:** more framework conventions to learn, and some architecture lives in decorators rather than explicit wiring. Mitigated by keeping business logic in plain services and the engine framework-light.
