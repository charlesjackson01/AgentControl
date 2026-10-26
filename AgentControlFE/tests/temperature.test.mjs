import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { TEMPERATURE_ERROR, TEMPERATURE_PLACEHOLDER, createTemperatureField, editTemperaturePatch, parseTemperature, temperatureText } from '../src/lib/temperature.ts'

describe('temperature field: blank = endpoint default (BE-4 af197cd / e2221c8)', () => {
  it('field text: blank when nothing is stored', () => {
    assert.equal(temperatureText(undefined), '')
    assert.equal(temperatureText(null), '')
    assert.equal(temperatureText(0), '0')
    assert.equal(temperatureText(0.7), '0.7')
  })
  it('validates only when something is entered (0–2)', () => {
    assert.deepEqual(parseTemperature(''), { value: null, error: null })
    assert.deepEqual(parseTemperature('   '), { value: null, error: null })
    assert.deepEqual(parseTemperature('0'), { value: 0, error: null })
    assert.deepEqual(parseTemperature('2'), { value: 2, error: null })
    assert.deepEqual(parseTemperature(' 0.7 '), { value: 0.7, error: null })
    for (const bad of ['2.1', '-0.1', 'abc', 'Infinity', 'NaN']) assert.equal(parseTemperature(bad).error, TEMPERATURE_ERROR, bad)
  })
  it('create: blank omits the key; a value (e.g. the Team Lead preset 0.7) is sent as a number', () => {
    assert.deepEqual(createTemperatureField(''), {})
    assert.equal('temperature' in createTemperatureField(''), false)
    assert.deepEqual(createTemperatureField('0.7'), { temperature: 0.7 })
    assert.deepEqual(createTemperatureField('0'), { temperature: 0 })
    assert.equal(typeof createTemperatureField('1.5').temperature, 'number')
    assert.deepEqual(createTemperatureField('9'), {}, 'invalid never reaches the body')
  })
  it('edit: unchanged sends nothing', () => {
    assert.equal(editTemperaturePatch(0.7, '0.7'), null)
    assert.equal(editTemperaturePatch(0.7, ' 0.70 '), null)
    assert.equal(editTemperaturePatch(undefined, ''), null)
    assert.equal(editTemperaturePatch(0, '0'), null)
  })
  it('edit: blank over a stored value PATCHes temperature: null', () => {
    assert.deepEqual(editTemperaturePatch(0.7, ''), { temperature: null })
    assert.deepEqual(editTemperaturePatch(0, ''), { temperature: null }, '0 is a stored value, not blank')
  })
  it('edit: a new value PATCHes the number', () => {
    assert.deepEqual(editTemperaturePatch(undefined, '0.7'), { temperature: 0.7 })
    assert.deepEqual(editTemperaturePatch(0.7, '1.2'), { temperature: 1.2 })
    assert.equal(editTemperaturePatch(0.7, '3'), null, 'invalid never reaches the body')
  })
})

describe('AgentProfile wiring', () => {
  const src = readFileSync(new URL('../src/components/AgentProfile.tsx', import.meta.url), 'utf8')
  it('placeholder "Endpoint default", no required marker', () => {
    assert.equal(TEMPERATURE_PLACEHOLDER, 'Endpoint default')
    assert.match(src, /placeholder=\{TEMPERATURE_PLACEHOLDER\}/)
    assert.doesNotMatch(src, /Temperature <span className="field__req"/)
  })
  it('Team Lead preset 0.7; edit starts from the stored value; new bots start blank', () => {
    assert.match(src, /const tempBaseline = initial \? temperatureText\(initial\.temperature\) : isBootstrap \? '0\.7' : ''/)
  })
  it('create spreads createTemperatureField; edit PATCHes editTemperaturePatch and the PUT carries no temperature', () => {
    assert.match(src, /\.\.\.createTemperatureField\(tempText\)/)
    assert.match(src, /saved = await saveAgentEdit\(request, initial\.id, payload, editTemperaturePatch\(initial\.temperature, tempText\)\)/)
    assert.doesNotMatch(src, /temperature: agent\.temperature \?\? 0/)
    assert.doesNotMatch(src, /set\('temperature'/)
  })
})
