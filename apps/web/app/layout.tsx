import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'QuotaCarry', description: 'Transfer AI compute rights, not API keys.' };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
