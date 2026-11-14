import tseslint from 'typescript-eslint';
export default [{ ignores: ['**/dist/**', '**/.next/**', '**/.open-next/**', '**/.wrangler/**', '**/next-env.d.ts'] }, ...tseslint.configs.recommended];
