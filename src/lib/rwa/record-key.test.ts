/** npm run test:record-key */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { appendDistinct, transferRecordKey } from './record-key.js'
import type { RwaTransfer } from './transfers.js'

const mk = (id: string, from: string, to: string, value: string): RwaTransfer => ({
  id, from, to, value, hash: 'h', timeStamp: '0', blockNumber: '0', nonce: '', blockHash: '', contractAddress: '',
  tokenName: '', tokenSymbol: '', tokenDecimal: '', transactionIndex: '', gas: '', gasPrice: '', gasUsed: '',
  cumulativeGasUsed: '', input: '', confirmations: '',
})

describe('appendDistinct', () => {
  test('the §A6 case: two DISTINCT records sharing a dash id are both kept', () => {
    const a = mk('2-2623H5ug-1', 'fn1Ng9KN', '35Krbni', '315807')
    const b = mk('2-2623H5ug-1', 'B3qgoC7X', 'fn1Ng9KN', '315807')
    const out: RwaTransfer[] = []
    const seen = new Set<string>()
    assert.equal(appendDistinct(out, [a], seen), 0)
    assert.equal(appendDistinct(out, [b], seen), 0)
    assert.equal(out.length, 2)
    assert.notEqual(transferRecordKey(a), transferRecordKey(b))
  })

  test('an exact repeat across a page boundary is dropped and counted', () => {
    const a = mk('2-h-7', 'X', 'Y', '1')
    const out: RwaTransfer[] = []
    const seen = new Set<string>()
    appendDistinct(out, [a, mk('2-h-8', 'Y', 'Z', '1')], seen)   // page 1
    const dropped = appendDistinct(out, [mk('2-h-7', 'X', 'Y', '1'), mk('2-h-9', 'Z', 'W', '2')], seen) // page 2 repeats the boundary row
    assert.equal(dropped, 1)
    assert.deepEqual(out.map((t) => t.id), ['2-h-7', '2-h-8', '2-h-9'])
  })
})
