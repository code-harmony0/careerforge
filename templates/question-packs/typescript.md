# TypeScript question pack (senior)

**Source:** curated for this repository, 2026-08-24.
**Licence:** MIT, same as this repository.

Type-system questions that separate someone who annotates from someone who
models. Skewed toward the situations that come up in application code rather
than type-level puzzles for their own sake.

- Explain structural typing, and where it surprises people coming from Java or C#
- What is the difference between an interface and a type alias, and when does it matter
- Explain unknown versus any versus never, and when you would reach for each
- What are discriminated unions and why do they beat optional fields
- Explain generics with a real example from code you have written
- What does a type guard do, and how do you write one that the compiler trusts
- Explain conditional types, and when they are worth the readability cost
- What are mapped types and what problem do they actually solve
- Explain declaration merging and why it matters when typing a third-party module
- How do you type an API response you do not control
- What is the role of a runtime validator like Zod or Yup when you already have types
- Explain why TypeScript types disappear at runtime and what that means for your design
- What is strict mode actually turning on, and which flag causes the most pain to adopt
- How would you incrementally add TypeScript to a large JavaScript codebase
- When is `as` justified, and how do you stop it spreading through a codebase
- Explain variance, and give a case where it caused you a real bug
- How do you type a higher-order component or a hook with generic arguments
- What is the difference between `readonly` and `const`, and what do they each not protect
- How do you share types between a client and a server without duplicating them
- Explain what a `.d.ts` file is for and when you would write one by hand
