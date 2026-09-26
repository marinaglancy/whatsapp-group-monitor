import { describe, it, expect } from 'vitest'
import { loadToolDeclarations, rawToolDeclarations } from '../../src/ai/tools/loader.js'

describe('tool declaration loader', () => {
  it('loads the five reviewed tools', () => {
    const names = loadToolDeclarations({ timezone: 'UTC' }).map(t => t.name).sort()
    expect(names).toEqual(['activity_stats', 'group_list', 'group_members', 'group_messages', 'message_search'])
  })

  it('strips _-prefixed metadata and expands {{timezone}} everywhere', () => {
    const tools = loadToolDeclarations({ timezone: 'Europe/Lisbon' })
    const json = JSON.stringify(tools)
    expect(json).not.toContain('"_')
    expect(json).not.toContain('{{')
    expect(json).toContain('Europe/Lisbon')
  })

  it('keeps parameters and responseJsonSchema intact apart from placeholders', () => {
    const raw = rawToolDeclarations()
    const loaded = loadToolDeclarations({ timezone: 'UTC' })
    for (const tool of loaded) {
      const orig = raw.find(t => t.name === tool.name)!
      expect(tool.parameters).toEqual(JSON.parse(JSON.stringify(orig.parameters).replaceAll('{{timezone}}', 'UTC')))
      expect(tool.responseJsonSchema).toEqual(JSON.parse(JSON.stringify(orig.responseJsonSchema).replaceAll('{{timezone}}', 'UTC')))
    }
  })
})
