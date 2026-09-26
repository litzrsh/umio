# Test coverage checklist

- Is there a test that fails without the change and passes with it?
- Are error paths tested, not only the happy path?
- Are boundary values covered (empty, one, many; zero and limits)?
- Is time, randomness or I/O controlled (fake clock, seeded values, temp dirs)?
- Does a test pin behavior that callers rely on?
