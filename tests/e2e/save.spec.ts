import { TOKEN, api, drawRectangle, expect, openViewer, shared, test } from './fixtures';

const search = (q: string) => `/api/saved?q=${encodeURIComponent(q)}`;

test('⌘/Ctrl+S saves the board, including an edit not sent yet, under the board title or a new name', async ({ page, rest, canvasId, request }) => {
  const { buildElements } = await shared();
  const put = await request.put(api.canvas(canvasId), { headers: { Authorization: `Bearer ${TOKEN}` }, data: { title: `Flow ${canvasId}`, workspace: '/e2e/space' } });
  expect(put.status()).toBe(200);
  await rest.post(api.elements(canvasId), { elements: buildElements([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Agent box' }], []).elements });
  await openViewer(page, canvasId);

  await drawRectangle(page, { x: 420, y: 300 }, { x: 580, y: 400 });
  await page.keyboard.press('ControlOrMeta+s');
  const form = page.getByTestId('save-form');
  const name = form.getByLabel('Board name');
  await expect(name).toHaveValue(`Flow ${canvasId}`);
  // An edit in the same tick as the submit is still inside the 100ms send throttle.
  await page.evaluate(() => {
    const ex = window.__excalidrawAPI;
    const drawn = ex.getSceneElements().find((el: { id: string; type: string }) => el.type === 'rectangle' && el.id !== 'a');
    ex.updateScene({ elements: [...ex.getSceneElementsIncludingDeleted(), { ...drawn, id: 'late', x: drawn.x + 400, version: 1, versionNonce: 5 }] });
    document.querySelector<HTMLFormElement>('[data-testid="save-form"]')!.requestSubmit();
  });
  await expect(page.locator('.Toast')).toContainText(`Saved "Flow ${canvasId}"`);
  await expect(form).toHaveCount(0);
  const [saved] = await rest.get(search(canvasId));
  expect(saved).toMatchObject({ name: `Flow ${canvasId}`, elementCount: 4, source: canvasId, workspace: '/e2e/space' });

  await page.keyboard.press('ControlOrMeta+s');
  await name.fill(`Renamed ${canvasId}`);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.Toast')).toContainText(`Saved "Renamed ${canvasId}"`);
  expect((await rest.get(search(canvasId))).map((s: { name: string }) => s.name).sort()).toEqual([`Flow ${canvasId}`, `Renamed ${canvasId}`]);
});

test('the main menu opens the save form; an untitled board needs a name; Escape closes it', async ({ page, rest, canvasId }) => {
  await openViewer(page, canvasId);
  await page.locator('.main-menu-trigger').click();
  await page.getByTestId('save-to-library').click();
  const form = page.getByTestId('save-form');
  await expect(form.getByLabel('Board name')).toHaveValue('');
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
  await form.getByLabel('Board name').press('Escape');
  await expect(form).toHaveCount(0);

  await page.locator('.main-menu-trigger').click();
  await page.getByTestId('save-to-library').click();
  await form.getByLabel('Board name').fill(`Menu ${canvasId}`);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.Toast')).toContainText(`Saved "Menu ${canvasId}"`);
  expect(await rest.get(search(canvasId))).toEqual([expect.objectContaining({ name: `Menu ${canvasId}`, elementCount: 0, source: canvasId })]);
});
