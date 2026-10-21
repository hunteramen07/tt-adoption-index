/** npm run test:aum-series */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AumCoverageError,
  coverageThroughFromExecution,
  forwardFill,
  groupRowsByProduct,
  lookupAum,
  overlapSince,
} from './aumSeries.js'
import type { ActiveProduct } from '@/src/config/products'

const pts = (...days: Array<[string, string]>) => days.map(([day, supplyRaw]) => ({ day, supplyRaw }))

describe('coverageThroughFromExecution — the day before the execution UTC date', () => {
  test('an execution on the 1st covers the whole previous month', () => {
    assert.equal(coverageThroughFromExecution('2026-10-01T06:35:12.000Z'), '2026-09-30')
    assert.equal(coverageThroughFromExecution('2026-10-01T00:00:00Z'), '2026-09-30')
    assert.equal(coverageThroughFromExecution('2026-10-01T23:59:59Z'), '2026-09-30')
  })
  test('the 2026-09-23 execution does NOT cover 2026-09-30', () => {
    assert.equal(coverageThroughFromExecution('2026-09-23T12:06:42.691573Z'), '2026-09-22')
  })
  test('rejects garbage', () => {
    assert.throws(() => coverageThroughFromExecution('not a date'))
  })
})

describe('overlapSince', () => {
  test('steps back whole UTC days, across month boundaries', () => {
    assert.equal(overlapSince('2026-10-03', 7), '2026-09-26')
    assert.equal(overlapSince('2026-03-01', 1), '2026-02-28')
    assert.equal(overlapSince('2026-10-19', 0), '2026-10-19')
  })
})

describe('forwardFill', () => {
  test('fills every day between the first and last rows, carrying supply forward', () => {
    const s = forwardFill(pts(['2026-09-01', '1000000'], ['2026-09-04', '3000000']), 6, 1)
    assert.deepEqual(s.map((p) => [p.day, p.aum]), [
      ['2026-09-01', 1], ['2026-09-02', 1], ['2026-09-03', 1], ['2026-09-04', 3],
    ])
    assert.equal(s[2].supplyRaw, '1000000')
  })
  test('applies decimals and NAV', () => {
    const s = forwardFill(pts(['2026-09-01', '2000000000000000000']), 18, 1.15)
    assert.equal(s[0].aum, 2.3)
  })
  test('empty in, empty out', () => {
    assert.deepEqual(forwardFill([], 6, 1), [])
  })
})

describe('lookupAum — never forward-fills past coverage', () => {
  const series = forwardFill(pts(['2026-09-01', '1000000'], ['2026-09-20', '5000000']), 6, 1)
  const coverage = '2026-09-22' // what a 2026-09-23 execution covers

  test('exact day and in-series forward fill', () => {
    assert.equal(lookupAum(series, '2026-09-20', coverage, 'usdy'), 5)
    assert.equal(lookupAum(series, '2026-09-10', coverage, 'usdy'), 1)
  })
  test('after the last row but within coverage: a real no-change stretch, returns the last row', () => {
    assert.equal(lookupAum(series, '2026-09-22', coverage, 'usdy'), 5)
  })
  test('the month-end beyond coverage THROWS, naming the product, the request and the coverage', () => {
    assert.throws(
      () => lookupAum(series, '2026-09-30', coverage, 'usdy'),
      (err: unknown) => {
        assert.ok(err instanceof AumCoverageError)
        assert.equal(err.label, 'usdy')
        assert.equal(err.requested, '2026-09-30')
        assert.equal(err.coverageThrough, '2026-09-22')
        assert.equal(err.seriesEnd, '2026-09-20')
        assert.match(err.message, /2026-09-30/)
        assert.match(err.message, /refresh-dune/)
        return true
      }
    )
  })
  test('before the first row is null (product not live yet), not an error', () => {
    assert.equal(lookupAum(series, '2026-08-31', coverage, 'usdy'), null)
    assert.equal(lookupAum([], '2026-08-31', coverage, 'usdy'), null)
  })
  test('an empty series beyond coverage still throws — coverage is checked first', () => {
    assert.throws(() => lookupAum([], '2026-09-30', coverage, 'usdy'), AumCoverageError)
  })
})

describe('groupRowsByProduct', () => {
  const products = [
    { slug: 'usdy', contractAddress: '0xABCDEF0000000000000000000000000000000001' },
    { slug: 'ousg', contractAddress: '0x0000000000000000000000000000000000000002' },
  ] as unknown as readonly ActiveProduct[]
  test('matches on lowercase address, sorts by day, drops unknown addresses', () => {
    const g = groupRowsByProduct(
      [
        { contractAddress: '0xabcdef0000000000000000000000000000000001', day: '2026-09-02', supplyRaw: '2' },
        { contractAddress: '0xabcdef0000000000000000000000000000000001', day: '2026-09-01', supplyRaw: '1' },
        { contractAddress: '0x0000000000000000000000000000000000000099', day: '2026-09-01', supplyRaw: '9' }, // BENJI-like
      ],
      products
    )
    assert.deepEqual([...g.keys()], ['usdy'])
    assert.deepEqual(g.get('usdy')!.map((p) => p.supplyRaw), ['1', '2'])
  })
})
