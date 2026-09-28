import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger, logger } from '@mira/shared-core/logger'

function collect(): { lines: string[]; write(msg: string): void } {
  const lines: string[] = []
  return {
    lines,
    write(msg: string) {
      lines.push(msg)
    },
  }
}

function parseLine(msg: string): unknown {
  return JSON.parse(msg.trimEnd())
}

describe('shared-core logger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('[unhappy]', () => {
    it('does not double-write: warn stays off stdout, info stays off stderr', () => {
      const warnStdout = collect()
      const warnLog = createLogger({ stdout: warnStdout, stderr: collect() })

      warnLog.warn('x')
      expect(warnStdout.lines).toHaveLength(0)

      const infoStdout = collect()
      const infoStderr = collect()
      const infoLog = createLogger({ stdout: infoStdout, stderr: infoStderr })

      infoLog.info('x')
      expect(infoStderr.lines).toHaveLength(0)
    })

    it('serialises an Error under the err key with pino std serializer fields', () => {
      const stdout = collect()
      const stderr = collect()
      const log = createLogger({ stdout, stderr })

      log.info('x', { err: new Error('test') })

      expect(stdout.lines).toHaveLength(1)
      const parsed: unknown = parseLine(stdout.lines[0])
      expect(parsed).toMatchObject({
        err: {
          type: 'Error',
          message: 'test',
          stack: expect.stringMatching(/\S/),
        },
      })
    })

    it('serialises an Error under the error key, and passes a plain string through unchanged', () => {
      const stdout = collect()
      const log = createLogger({ stdout, stderr: collect() })

      log.info('x', { error: new Error('e') })
      let parsed: unknown = parseLine(stdout.lines[0])
      expect(parsed).toMatchObject({ error: { message: 'e' } })

      log.info('x', { error: 'plain string' })
      parsed = parseLine(stdout.lines[1])
      expect(parsed).toMatchObject({ error: 'plain string' })
    })

    it('redacts a top-level sensitive field without removing the key', () => {
      const stdout = collect()
      const log = createLogger({ stdout, stderr: collect() })

      log.info('x', { authorization: 'Bearer secret' })

      const parsed: unknown = parseLine(stdout.lines[0])
      expect(parsed).toMatchObject({ authorization: '[Redacted]' })
    })

    it('redacts a nested sensitive field one level deep', () => {
      const stdout = collect()
      const log = createLogger({ stdout, stderr: collect() })

      log.info('x', { headers: { authorization: 'Bearer s' } })

      const parsed: unknown = parseLine(stdout.lines[0])
      expect(parsed).toMatchObject({ headers: { authorization: '[Redacted]' } })
    })

    it('JSON-escapes a message containing a newline', () => {
      const stdout = collect()
      const log = createLogger({ stdout, stderr: collect() })

      log.info('x\ny')

      expect(stdout.lines).toHaveLength(1)
      expect(() => parseLine(stdout.lines[0])).not.toThrow()
    })

    it('does not throw on circular context', () => {
      const stdout = collect()
      const log = createLogger({ stdout, stderr: collect() })
      const o: Record<string, unknown> = {}
      o.self = o

      expect(() => log.info('x', o)).not.toThrow()
      expect(stdout.lines).toHaveLength(1)
      expect(() => parseLine(stdout.lines[0])).not.toThrow()
    })

    it('suppresses debug output when the env gate is off', () => {
      const stdout = collect()
      const log = createLogger({ env: {}, stdout, stderr: collect() })

      log.debug('x')

      expect(stdout.lines).toHaveLength(0)
    })

    it('exposes the default logger as a plain object whose methods can be spied on', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      logger.warn('x')

      expect(warnSpy).toHaveBeenCalledWith('x')
    })
  })

  describe('[happy]', () => {
    it('writes exactly one JSON line with a string level label, ISO time, msg, and top-level context', () => {
      const stdout = collect()
      const log = createLogger({ stdout, stderr: collect() })

      log.info('x', { jobId: 'j1' })

      expect(stdout.lines).toHaveLength(1)
      const parsed: unknown = parseLine(stdout.lines[0])
      expect(parsed).toMatchObject({
        level: 'info',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
        msg: 'x',
        jobId: 'j1',
      })
    })

    it('sends info to stdout only', () => {
      const stdout = collect()
      const stderr = collect()
      const log = createLogger({ stdout, stderr })

      log.info('x')

      expect(stdout.lines).toHaveLength(1)
      expect(stderr.lines).toHaveLength(0)
    })

    it('sends debug to stdout when MIRA_DEBUG_LOGGING=true', () => {
      const stdout = collect()
      const stderr = collect()
      const log = createLogger({ env: { MIRA_DEBUG_LOGGING: 'true' }, stdout, stderr })

      log.debug('x')

      expect(stdout.lines).toHaveLength(1)
      const parsed: unknown = parseLine(stdout.lines[0])
      expect(parsed).toMatchObject({ level: 'debug' })
      expect(stderr.lines).toHaveLength(0)
    })

    it('sends debug to stdout when NODE_ENV=development', () => {
      const stdout = collect()
      const stderr = collect()
      const log = createLogger({ env: { NODE_ENV: 'development' }, stdout, stderr })

      log.debug('x')

      expect(stdout.lines).toHaveLength(1)
    })

    it('sends warn to stderr only', () => {
      const stderr = collect()
      const log = createLogger({ stdout: collect(), stderr })

      log.warn('x')

      expect(stderr.lines).toHaveLength(1)
      const parsed: unknown = parseLine(stderr.lines[0])
      expect(parsed).toMatchObject({ level: 'warn' })
    })

    it('sends error to stderr only', () => {
      const stderr = collect()
      const log = createLogger({ stdout: collect(), stderr })

      log.error('x')

      expect(stderr.lines).toHaveLength(1)
      const parsed: unknown = parseLine(stderr.lines[0])
      expect(parsed).toMatchObject({ level: 'error' })
    })

    it('includes base fields on every line, across both streams', () => {
      const stdout = collect()
      const stderr = collect()
      const log = createLogger({ base: { service: 'api' }, stdout, stderr })

      log.info('a')
      log.error('b')

      const infoLine: unknown = parseLine(stdout.lines[0])
      const errorLine: unknown = parseLine(stderr.lines[0])
      expect(infoLine).toMatchObject({ service: 'api' })
      expect(errorLine).toMatchObject({ service: 'api' })
    })
  })
})
