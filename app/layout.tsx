import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { Nav } from "./components/Nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RTA Index — Tokenized Treasury Adoption",
  description:
    "Real-time adoption index for tokenized U.S. Treasury products. Tracks BlackRock BUIDL, Ondo OUSG & USDY, Superstate USTB, and Hashnote USYC.",
};

// Static fallback for the Suspense boundary around Nav.
// usePathname() in Nav is runtime data on dynamic route templates (/fund/[slug]),
// so Nav must be wrapped in Suspense to allow the template shell to prerender.
// This fallback renders all links inactive — visually identical to the real Nav
// on fund pages where no nav link is ever active.
function NavFallback() {
  const links = [
    { href: '/', label: 'Overview' },
    { href: '/holders', label: 'Holders' },
    { href: '/methodology', label: 'Methodology' },
  ]
  return (
    <header className="border-b border-zinc-100 bg-white sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center">
        <span className="mr-6 py-4 shrink-0 text-sm font-semibold tracking-widest uppercase text-zinc-800">
          RTA Index
        </span>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {links.map(({ href, label }) => (
            <span
              key={href}
              className="px-3 py-4 text-sm font-medium border-b-2 border-transparent text-zinc-500 whitespace-nowrap"
            >
              {label}
            </span>
          ))}
        </nav>
      </div>
    </header>
  )
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Suspense fallback={<NavFallback />}>
          <Nav />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
