import tseslint from 'typescript-eslint';
export default [{ ignores: ['**/dist/**', '**/.next/**', '**/next-env.d.ts'] }, ...tseslint.configs.recommended];
