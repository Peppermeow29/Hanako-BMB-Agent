import { describe, expect, it } from 'vitest';
import {
  collectElicitationValue,
  initialElicitationValues,
  missingRequiredFields,
  readElicitationForm,
} from '../../components/input/elicitation-schema';
import type { SessionConfirmationBlock } from '../../stores/chat-types';

function block(requestedSchema: unknown): SessionConfirmationBlock {
  return {
    type: 'session_confirmation',
    confirmId: 'c1',
    kind: 'mcp_elicitation',
    surface: 'input',
    status: 'pending',
    title: 'Remote Service',
    payload: { requestedSchema },
  };
}

describe('elicitation schema', () => {
  it('reads a flat object of primitives', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        subscribe: { type: 'boolean', default: true },
      },
    }))!;

    expect(form.groups).toHaveLength(1);
    expect(form.groups[0].fields.map(f => [f.key, f.type])).toEqual([
      ['name', 'string'],
      ['age', 'number'],
      ['subscribe', 'boolean'],
    ]);
    expect(form.unsupported).toEqual([]);
  });

  it('renders an enum as a set of choices rather than free text', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: {
        env: { type: 'string', enum: ['dev', 'prod'], enumNames: ['Development', 'Production'] },
      },
    }))!;

    const [field] = form.groups[0].fields;
    expect(field.type).toBe('enum');
    expect(field.options).toEqual([
      { value: 'dev', label: 'Development' },
      { value: 'prod', label: 'Production' },
    ]);
  });

  it('falls back to the raw value when a choice has no display name', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: { level: { type: 'integer', enum: [1, 2] } },
    }))!;

    expect(form.groups[0].fields[0].options).toEqual([
      { value: '1', label: '1' },
      { value: '2', label: '2' },
    ]);
  });

  it('groups one level of nesting instead of refusing the whole form', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: {
          type: 'object',
          title: 'Address',
          properties: { city: { type: 'string' }, zip: { type: 'string' } },
          required: ['city'],
        },
      },
    }))!;

    expect(form.groups.map(g => g.key)).toEqual(['', 'address']);
    const nested = form.groups[1];
    expect(nested.label).toBe('Address');
    expect(nested.fields.map(f => f.key)).toEqual(['address.city', 'address.zip']);
    expect(nested.fields[0].required).toBe(true);
    expect(form.unsupported).toEqual([]);
  });

  it('reports a second level of nesting as unsupported rather than flattening it', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'object', properties: { deep: { type: 'string' } } } },
        },
      },
    }))!;

    expect(form.groups).toEqual([]);
    expect(form.unsupported).toEqual(['outer']);
  });

  it('reports a field type it has no honest control for', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: { tags: { type: 'array' } },
    }))!;

    expect(form.unsupported).toEqual(['tags']);
  });

  it('seeds values from the schema defaults', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: {
        name: { type: 'string', default: 'octocat' },
        subscribe: { type: 'boolean', default: true },
        env: { type: 'string', enum: ['dev', 'prod'], default: 'prod' },
      },
    }));

    expect(initialElicitationValues(form)).toEqual({
      name: 'octocat',
      subscribe: true,
      env: 'prod',
    });
  });

  it('names the required fields the user left blank', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: { name: { type: 'string' }, note: { type: 'string' } },
      required: ['name'],
    }));

    expect(missingRequiredFields(form, { name: '   ', note: '' }).map(f => f.key)).toEqual(['name']);
    expect(missingRequiredFields(form, { name: 'octocat', note: '' })).toEqual([]);
  });

  it('treats a required boolean as answered either way', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: { agree: { type: 'boolean' } },
      required: ['agree'],
    }));

    expect(missingRequiredFields(form, { agree: false })).toEqual([]);
  });

  it('rebuilds the nested shape the server asked for', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'object', properties: { city: { type: 'string' }, zip: { type: 'string' } } },
      },
    }));

    expect(collectElicitationValue(form, {
      name: 'octocat',
      'address.city': 'Berlin',
      'address.zip': '10115',
    })).toEqual({
      name: 'octocat',
      address: { city: 'Berlin', zip: '10115' },
    });
  });

  it('leaves an untouched optional number out rather than sending NaN', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: { age: { type: 'integer' }, name: { type: 'string' } },
    }));

    expect(collectElicitationValue(form, { age: '', name: 'octocat' })).toEqual({ name: 'octocat' });
  });

  it('leaves an unanswered choice out', () => {
    const form = readElicitationForm(block({
      type: 'object',
      properties: { env: { type: 'string', enum: ['dev', 'prod'] } },
    }));

    expect(collectElicitationValue(form, { env: '' })).toEqual({});
  });

  it('ignores a block that is not an elicitation', () => {
    expect(readElicitationForm({ ...block({}), kind: 'tool_action_approval' })).toBeNull();
  });
});
