import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// NOTE: eslint is pinned to 9.x on purpose. eslint-config-next@16.2.12 ships
// `eslint-config-next/parser`, which returns a ScopeManager lacking the
// `addGlobals` method that eslint 10 calls in SourceCode#finalize, so every
// lint run under eslint 10 dies with:
//   TypeError: scopeManager.addGlobals is not a function
// Revisit once eslint-config-next declares real eslint 10 support.
const eslintConfig = [
  ...nextCoreWebVitals,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "public/sw.js",
    ],
  },
];

export default eslintConfig;
