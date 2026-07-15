/** @type {import('@types/eslint').Linter.BaseConfig} */
module.exports = {
  root: true,
  extends: [
    "@remix-run/eslint-config",
    "@remix-run/eslint-config/node",
    "@remix-run/eslint-config/jest-testing-library",
    "prettier",
  ],
  globals: {
    shopify: "readonly"
  },
  settings: {
    // This project uses Vitest (not Jest), so eslint-plugin-jest's automatic
    // Jest-version detection (via `require.resolve('jest/package.json')`)
    // fails and crashes the linter. Vitest's test globals are Jest-API
    // compatible, so declare a recent Jest version explicitly to satisfy
    // rules like `jest/no-deprecated-functions` without adding a real
    // `jest` dependency.
    jest: {
      version: 29,
    },
  },
};
