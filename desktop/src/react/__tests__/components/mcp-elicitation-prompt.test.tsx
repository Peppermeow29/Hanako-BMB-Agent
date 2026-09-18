// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { SessionConfirmationPrompt } from '../../components/input/SessionConfirmationPrompt';
import type { SessionConfirmationBlock } from '../../stores/chat-types';

const hanaFetchMock = vi.fn<(path: string, opts?: RequestInit) => Promise<Response>>(
  async () => new Response('{}', { status: 200 }),
);

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (path: string, opts?: RequestInit) => hanaFetchMock(path, opts),
  hanaUrl: (path: string) => `http://127.0.0.1:3210${path}`,
}));

function elicitationBlock(requestedSchema: unknown): SessionConfirmationBlock {
  return {
    type: 'session_confirmation',
    confirmId: 'confirm-1',
    kind: 'mcp_elicitation',
    surface: 'input',
    status: 'pending',
    title: 'Remote Service',
    body: 'Please provide your GitHub username',
    subject: { label: 'Remote Service', detail: 'deploy' },
    severity: 'normal',
    actions: { confirmLabel: 'Approve', rejectLabel: 'Deny' },
    payload: {
      connectorName: 'Remote Service',
      toolName: 'deploy',
      message: 'Please provide your GitHub username',
      requestedSchema,
    },
  };
}

function lastConfirmBody() {
  const call = hanaFetchMock.mock.calls.at(-1);
  return JSON.parse(String(call?.[1]?.body));
}

describe('mcp_elicitation confirmation prompt', () => {
  beforeEach(() => {
    hanaFetchMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders one input per requested field and submits the collected values', async () => {
    render(
      <SessionConfirmationPrompt
        block={elicitationBlock({
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Username' },
            age: { type: 'number', title: 'Age' },
            subscribe: { type: 'boolean', title: 'Subscribe' },
          },
          required: ['name'],
        })}
      />,
    );

    // The server's own explanation is what the user reads before answering.
    expect(screen.getByText('Please provide your GitHub username')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'octocat' } });
    fireEvent.change(screen.getByLabelText('Age'), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('Subscribe'));
    fireEvent.click(screen.getByText('Approve'));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalled());
    const [path] = hanaFetchMock.mock.calls.at(-1)!;
    expect(path).toBe('/api/confirm/confirm-1');
    expect(lastConfirmBody()).toEqual({
      action: 'confirmed',
      value: { name: 'octocat', age: 30, subscribe: true },
    });
  });

  it('rejects without collecting any values', async () => {
    render(<SessionConfirmationPrompt block={elicitationBlock({
      type: 'object',
      properties: { name: { type: 'string' } },
    })} />);

    fireEvent.click(screen.getByText('Deny'));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalled());
    expect(lastConfirmBody()).toEqual({ action: 'rejected' });
  });

  it('refuses to submit a field type it cannot render', async () => {
    render(<SessionConfirmationPrompt block={elicitationBlock({
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Username' },
        tags: { type: 'array', title: 'Tags' },
      },
    })} />);

    expect(screen.getByTestId('elicitation-unsupported')).toBeTruthy();
    // Submitting a form we cannot faithfully fill would send the server a
    // half-answer, so approval is blocked rather than silently incomplete.
    const approve = screen.getByText('Approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    // Declining stays available: the user can always get out.
    fireEvent.click(screen.getByText('Deny'));
    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalled());
    expect(lastConfirmBody()).toEqual({ action: 'rejected' });
  });

  it('falls back to the property name when the schema gives no title', () => {
    render(<SessionConfirmationPrompt block={elicitationBlock({
      type: 'object',
      properties: { github_login: { type: 'string' } },
    })} />);

    expect(screen.getByLabelText('github_login')).toBeTruthy();
  });

  it('leaves other confirmation kinds untouched', () => {
    render(
      <SessionConfirmationPrompt
        block={{
          ...elicitationBlock({ type: 'object', properties: { name: { type: 'string' } } }),
          kind: 'tool_action_approval',
        }}
      />,
    );

    expect(screen.queryByLabelText('name')).toBeNull();
  });
  it('renders an enumerated field as a set of choices', async () => {
    render(
      <SessionConfirmationPrompt
        block={elicitationBlock({
          type: 'object',
          properties: {
            env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'], enumNames: ['Development', 'Production'] },
          },
        })}
      />,
    );

    // A closed set of options is a choice, not free text the user must spell.
    expect(screen.queryByLabelText('Environment')).toBeNull();
    fireEvent.click(screen.getByText('请选择'));
    expect(screen.getByText('Development')).toBeTruthy();
    expect(screen.getByText('Production')).toBeTruthy();
  });

  it('groups a nested object instead of refusing the whole form', async () => {
    render(
      <SessionConfirmationPrompt
        block={elicitationBlock({
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Username' },
            address: {
              type: 'object',
              title: 'Address',
              properties: { city: { type: 'string', title: 'City' } },
            },
          },
        })}
      />,
    );

    expect(screen.getByText('Address')).toBeTruthy();
    expect(screen.getByLabelText('City')).toBeTruthy();
    expect(screen.queryByTestId('elicitation-unsupported')).toBeNull();
  });

  it('will not submit while a required field is blank', async () => {
    render(
      <SessionConfirmationPrompt
        block={elicitationBlock({
          type: 'object',
          properties: { name: { type: 'string', title: 'Username' } },
          required: ['name'],
        })}
      />,
    );

    fireEvent.click(screen.getByText('Approve'));

    await waitFor(() => expect(screen.getByTestId('elicitation-required')).toBeTruthy());
    // Nothing was sent: an incomplete answer is the user's to finish, not the
    // server's to reject.
    expect(hanaFetchMock).not.toHaveBeenCalled();
  });

  it('clears the required warning once the field is filled in', async () => {
    render(
      <SessionConfirmationPrompt
        block={elicitationBlock({
          type: 'object',
          properties: { name: { type: 'string', title: 'Username' } },
          required: ['name'],
        })}
      />,
    );

    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(screen.getByTestId('elicitation-required')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'octocat' } });
    expect(screen.queryByTestId('elicitation-required')).toBeNull();

    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalled());
    expect(lastConfirmBody()).toEqual({ action: 'confirmed', value: { name: 'octocat' } });
  });

  it('submits the nested shape the server asked for', async () => {
    render(
      <SessionConfirmationPrompt
        block={elicitationBlock({
          type: 'object',
          properties: {
            address: {
              type: 'object',
              title: 'Address',
              properties: { city: { type: 'string', title: 'City' } },
            },
          },
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Berlin' } });
    fireEvent.click(screen.getByText('Approve'));

    await waitFor(() => expect(hanaFetchMock).toHaveBeenCalled());
    expect(lastConfirmBody()).toEqual({ action: 'confirmed', value: { address: { city: 'Berlin' } } });
  });
});
