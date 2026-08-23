# React Native question pack (senior)

**Source:** curated for this repository, 2026-08-24.
**Licence:** MIT, same as this repository.

Deliberately NOT a beginner set — `react.md` already covers fundamentals. These
are the questions a senior mobile engineer gets asked once the interviewer has
decided you can write a component: architecture, the native boundary, release
engineering, and the things that only bite in production.

Topics track a real React Native stack: Hermes, the new architecture, Reanimated,
FlashList, MMKV, TanStack Query, native modules, in-app purchases, Fastlane.

## Architecture and the native boundary

- Explain the old bridge versus JSI, and what actually changed for performance
- What is the New Architecture (Fabric and TurboModules) and what breaks when you migrate to it
- How does Hermes differ from JSC, and when would you measure before switching
- Walk through what happens between a JS setState and a pixel changing on screen
- When would you write a native module instead of solving it in JavaScript
- How do you bridge an existing native SDK that has no React Native wrapper
- Explain the difference between the JS thread, the UI thread and the shadow thread
- How do you debug a crash that only reproduces in a release build on a physical device
- What does patch-package solve, and what is the cost of relying on it

## Performance

- How would you diagnose a list that stutters while scrolling
- Why FlashList over FlatList, and what does it actually change
- How do you find and fix a memory leak in a React Native app
- What causes slow app startup, and how would you measure it rather than guess
- Explain how Reanimated avoids the bridge, and when the worklet model bites you
- How would you reduce a bundle that has grown past acceptable download size
- How do you approach reducing cold-start latency in a content-heavy app
- What is your approach to image loading and caching at scale

## State and data

- When do you reach for TanStack Query over a global store, and why
- Explain optimistic updates and how you handle a failed mutation
- How do you design offline-first behaviour for a mobile app
- Why MMKV over AsyncStorage, and what are the tradeoffs
- How do you handle cache invalidation across screens after a mutation
- Compare Jotai, Redux and Context for a mid-size app, and defend your choice
- How do you keep a paginated list consistent when items are edited elsewhere

## Payments and platform services

- Walk through an In-App Purchase flow including receipt validation
- How do you handle a user losing connectivity mid-transaction
- What are the App Store rules about IAP versus external payment, and how did they affect your design
- How do you implement and test deep linking across both platforms
- How do you handle push notifications when the app is killed versus backgrounded
- What is your approach to internationalization, including RTL layouts

## Release engineering

- Describe your CI/CD pipeline for a mobile app from commit to store
- How do product flavors or schemes work, and why would you need them
- How do you manage code signing across a team without leaking credentials
- What is your rollout strategy for a risky release
- How do you decide between an over-the-air update and a store submission
- How do you monitor crashes in production and triage what to fix first

## Testing and quality

- What do you actually test in a React Native app, and what do you deliberately not test
- How do you write a test for a component that depends on a native module
- When is a Detox or Appium end-to-end test worth its maintenance cost
- How do you catch a regression that only appears on one OS version
