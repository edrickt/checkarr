import { expect } from "vitest";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";

// @testing-library/jest-dom/vitest extends whatever "vitest" resolves from
// jest-dom's own location - under pnpm that can be a different instance than
// the one running the tests, and the matchers silently never register.
// Extend the runner's expect directly instead.
expect.extend(jestDomMatchers);

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
