import { describe, expect, it } from 'vitest'
import { detectStoryPointsField } from '../../src/domain/jira-fields'

describe('detectStoryPointsField matching and canonical normalization (R10)', () => {
  it('matches company-managed "Story Points" with numeric schema and "set" operation', () => {
    const editMeta = {
      fields: {
        summary: {
          name: 'Summary',
          schema: { type: 'string', system: 'summary' },
          operations: ['set'],
        },
        customfield_10016: {
          name: 'Story Points',
          schema: {
            type: 'number',
            custom: 'com.pyxis.greenhopper.jira:jsw-story-points',
            customId: 10016,
          },
          operations: ['set'],
        },
      },
    }

    expect(detectStoryPointsField(editMeta)).toEqual({
      fieldId: 'customfield_10016',
      fieldName: 'Story Points',
    })
  })

  it('matches whitespace-padded and case-varied "  story point estimate " and normalizes canonical fieldName', () => {
    const editMeta = {
      fields: {
        customfield_10024: {
          name: '  story point estimate ',
          schema: { type: 'number' },
          operations: ['edit', 'set'],
        },
      },
    }

    expect(detectStoryPointsField(editMeta)).toEqual({
      fieldId: 'customfield_10024',
      fieldName: 'Story point estimate',
    })
  })

  it('normalizes uppercase and tab-padded " \\tSTORY POINTS  " to canonical "Story Points"', () => {
    const editMeta = {
      fields: {
        customfield_10018: {
          name: ' \tSTORY POINTS  ',
          schema: { type: 'number' },
          operations: ['set'],
        },
      },
    }

    expect(detectStoryPointsField(editMeta)).toEqual({
      fieldId: 'customfield_10018',
      fieldName: 'Story Points',
    })
  })

  it.each([
    {
      label: 'schema omitted and operations omitted',
      fieldDef: { name: 'Story Points' },
      expectedName: 'Story Points',
    },
    {
      label: 'schema null and operations null',
      fieldDef: { name: 'Story point estimate', schema: null, operations: null },
      expectedName: 'Story point estimate',
    },
    {
      label: 'schema empty object (type omitted) and operations containing set',
      fieldDef: { name: 'Story Points', schema: {}, operations: ['set'] },
      expectedName: 'Story Points',
    },
    {
      label: 'schema.type null and operations omitted',
      fieldDef: { name: 'Story point estimate', schema: { type: null } },
      expectedName: 'Story point estimate',
    },
  ])('matches candidate field when $label', ({ fieldDef, expectedName }) => {
    expect(
      detectStoryPointsField({
        fields: {
          customfield_10030: fieldDef,
        },
      }),
    ).toEqual({
      fieldId: 'customfield_10030',
      fieldName: expectedName,
    })
  })
})

describe('detectStoryPointsField precedence and deterministic tie-breaking (R10)', () => {
  it('prioritizes "Story Points" over "Story point estimate" even when "Story point estimate" has a smaller fieldId', () => {
    const editMeta = {
      fields: {
        customfield_10001: {
          name: 'Story point estimate',
          schema: { type: 'number' },
          operations: ['set'],
        },
        customfield_10099: {
          name: '  story points ',
          schema: { type: 'number' },
          operations: ['set'],
        },
      },
    }

    expect(detectStoryPointsField(editMeta)).toEqual({
      fieldId: 'customfield_10099',
      fieldName: 'Story Points',
    })
  })

  it('breaks same-tier "Story Points" ties by ascending lexicographical fieldId', () => {
    const editMeta = {
      fields: {
        customfield_10020: {
          name: 'Story Points',
          schema: { type: 'number' },
          operations: ['set'],
        },
        customfield_10010: {
          name: 'Story Points',
          schema: { type: 'number' },
          operations: ['set'],
        },
      },
    }

    expect(detectStoryPointsField(editMeta)).toEqual({
      fieldId: 'customfield_10010',
      fieldName: 'Story Points',
    })
  })

  it('breaks same-tier "Story point estimate" ties by ascending lexicographical fieldId', () => {
    const editMeta = {
      fields: {
        customfield_10050: {
          name: 'Story point estimate',
          schema: { type: 'number' },
          operations: ['set'],
        },
        customfield_10012: {
          name: 'Story point estimate',
          schema: { type: 'number' },
          operations: ['set'],
        },
      },
    }

    expect(detectStoryPointsField(editMeta)).toEqual({
      fieldId: 'customfield_10012',
      fieldName: 'Story point estimate',
    })
  })

  it('falls back to editable "Story point estimate" when "Story Points" on the same screen is read-only or non-numeric', () => {
    const editMeta = {
      fields: {
        customfield_10001: {
          name: 'Story Points',
          schema: { type: 'number' },
          operations: [],
        },
        customfield_10002: {
          name: 'Story Points',
          schema: { type: 'string' },
          operations: ['set'],
        },
        customfield_10026: {
          name: 'Story point estimate',
          schema: { type: 'number' },
          operations: ['set'],
        },
      },
    }

    expect(detectStoryPointsField(editMeta)).toEqual({
      fieldId: 'customfield_10026',
      fieldName: 'Story point estimate',
    })
  })

  it('matches localized or renamed Jira Software Story Points fields via jsw-story-points custom schema as tier-2 fallback', () => {
    const localizedEditMeta = {
      fields: {
        customfield_10030: {
          name: "Points d'histoire",
          schema: {
            type: 'number',
            custom: 'com.pyxis.greenhopper.jira:jsw-story-points',
          },
          operations: ['set'],
        },
      },
    }
    expect(detectStoryPointsField(localizedEditMeta)).toEqual({
      fieldId: 'customfield_10030',
      fieldName: "Points d'histoire",
    })

    // Exact English tier-0 and tier-1 names still take precedence over tier-2 schema fallback
    const multiTierEditMeta = {
      fields: {
        customfield_10005: {
          name: 'Renamed Points',
          schema: { type: 'number', custom: 'com.pyxis.greenhopper.jira:jsw-story-points' },
          operations: ['set'],
        },
        customfield_10099: {
          name: 'Story point estimate',
          schema: { type: 'number' },
          operations: ['set'],
        },
      },
    }
    expect(detectStoryPointsField(multiTierEditMeta)).toEqual({
      fieldId: 'customfield_10099',
      fieldName: 'Story point estimate',
    })

    // Read-only or non-numeric jsw-story-points fields remain disqualified
    expect(
      detectStoryPointsField({
        fields: {
          customfield_10030: {
            name: "Points d'histoire",
            schema: { type: 'number', custom: 'com.pyxis.greenhopper.jira:jsw-story-points' },
            operations: [],
          },
        },
      }),
    ).toBeNull()
  })
})

describe('detectStoryPointsField non-matching, read-only, and malformed payload resilience (R10)', () => {
  it.each([
    {
      label: 'non-matching field name "Story Points Legacy"',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Points Legacy',
            schema: { type: 'number' },
            operations: ['set'],
          },
        },
      },
    },
    {
      label: 'singular non-matching field name "Story Point"',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Point',
            schema: { type: 'number' },
            operations: ['set'],
          },
        },
      },
    },
    {
      label: 'plural hybrid field name "Story Points Estimate"',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Points Estimate',
            schema: { type: 'number' },
            operations: ['set'],
          },
        },
      },
    },
    {
      label: 'non-numeric schema type "string"',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Points',
            schema: { type: 'string' },
            operations: ['set'],
          },
        },
      },
    },
    {
      label: 'non-object schema primitive ("number")',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Points',
            schema: 'number',
            operations: ['set'],
          },
        },
      },
    },
    {
      label: 'array schema (["number"])',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Points',
            schema: ['number'],
            operations: ['set'],
          },
        },
      },
    },
    {
      label: 'read-only empty operations array',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Points',
            schema: { type: 'number' },
            operations: [],
          },
        },
      },
    },
    {
      label: 'operations lacking "set" (["add", "remove"])',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Points',
            schema: { type: 'number' },
            operations: ['add', 'remove'],
          },
        },
      },
    },
    {
      label: 'non-array operations ("set")',
      editMeta: {
        fields: {
          customfield_10016: {
            name: 'Story Points',
            schema: { type: 'number' },
            operations: 'set',
          },
        },
      },
    },
    {
      label: 'empty fields map',
      editMeta: { fields: {} },
    },
    {
      label: 'blank/whitespace fieldId key',
      editMeta: {
        fields: {
          '   ': {
            name: 'Story Points',
            schema: { type: 'number' },
            operations: ['set'],
          },
        },
      },
    },
    {
      label: 'reserved fieldId keys (constructor, prototype, __proto__)',
      editMeta: JSON.parse(
        '{"fields":{"__proto__":{"name":"Story Points","schema":{"type":"number"},"operations":["set"]},"constructor":{"name":"Story Points","schema":{"type":"number"},"operations":["set"]},"prototype":{"name":"Story Points","schema":{"type":"number"},"operations":["set"]}}}',
      ) as unknown,
    },
    {
      label: 'null editmeta',
      editMeta: null,
    },
    {
      label: 'undefined editmeta',
      editMeta: undefined,
    },
    {
      label: 'primitive string editmeta',
      editMeta: '{"fields":{}}',
    },
    {
      label: 'primitive number editmeta',
      editMeta: 403,
    },
    {
      label: 'primitive boolean editmeta',
      editMeta: false,
    },
    {
      label: 'array editmeta',
      editMeta: [{ fields: {} }],
    },
    {
      label: 'object missing fields property',
      editMeta: {},
    },
    {
      label: 'fields is null',
      editMeta: { fields: null },
    },
    {
      label: 'fields is an array',
      editMeta: { fields: [{ name: 'Story Points' }] },
    },
    {
      label: 'field definition is null or array or primitive',
      editMeta: {
        fields: {
          customfield_10016: null,
          customfield_10017: ['Story Points'],
          customfield_10018: 'Story Points',
        },
      },
    },
  ])('returns null without throwing for $label', ({ editMeta }) => {
    expect(detectStoryPointsField(editMeta)).toBeNull()
  })

  it('ignores inherited prototype properties on editMeta.fields', () => {
    const inheritedProto = {
      customfield_10016: {
        name: 'Story Points',
        schema: { type: 'number' },
        operations: ['set'],
      },
    }
    const fieldsWithInheritedOnly = Object.create(inheritedProto) as Record<string, unknown>
    expect(detectStoryPointsField({ fields: fieldsWithInheritedOnly })).toBeNull()
  })
})
