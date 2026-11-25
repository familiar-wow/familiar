// Vite bundles imported style sheets; TypeScript only needs to know they exist. The tsconfig
// leaves out vite/client on purpose (the tests run in Bun), so this is the one declaration.
declare module "*.css";
