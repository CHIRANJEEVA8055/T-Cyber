import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // App Router project: there is no pages/ directory.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    // Browser code: T-CYBER is opened over plain HTTP on the station network, where browsers do not offer
    // crypto.randomUUID or the Clipboard API (they need HTTPS or localhost). Use newId() and copyText() from
    // src/lib/browser.ts, which work everywhere.
    files: ["src/features/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}", "src/app/**/*.tsx", "src/lib/**/*.{ts,tsx}"],
    ignores: ["src/lib/browser.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "crypto", property: "randomUUID", message: "Not available over plain HTTP. Use newId() from @/lib/browser." },
        { object: "navigator", property: "clipboard", message: "Not available over plain HTTP. Use copyText() from @/lib/browser." },
        { object: "crypto", property: "subtle", message: "Not available over plain HTTP; do this on the server." },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    "data/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
