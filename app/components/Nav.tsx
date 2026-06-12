'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/holders', label: 'Holders' },
  { href: '/methodology', label: 'Methodology' },
  { href: '/roadmap', label: 'Roadmap' },
]

export function Nav() {
  const pathname = usePathname()

  return (
    <header className="border-b border-zinc-100 bg-white sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center">
        <Link
          href="/"
          className="mr-6 py-4 shrink-0 text-sm font-semibold tracking-widest uppercase text-zinc-800 hover:text-zinc-900"
        >
          RTA Index
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {LINKS.map(({ href, label }) => {
            const active =
              href === '/' ? pathname === '/' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? 'border-blue-600 text-zinc-900'
                    : 'border-transparent text-zinc-500 hover:text-zinc-800 hover:border-zinc-200'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
