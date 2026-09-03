// Front/rear panel drawing generator, ported from Volture (light mode only).
//
// SEL publishes one layered "master configuration drawing" PDF per relay
// family: every orderable option (chassis, comm interface, I/O board, ...) is
// an optional-content layer, and the part number says which layers are real
// for a given unit. This module turns (model, part number) into cropped
// front/rear PNGs: pick the PDF the metadata names for this part number,
// switch its layers to the part number's options, render the page, and crop
// the front/rear view boxes.
//
// Every step degrades explicitly: an unknown model or missing PDF throws (the
// caller treats drawings as best-effort), while a part number the metadata
// cannot place falls back to a default variant with a warning — a slightly
// wrong drawing beats none.

import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, PDFArray, PDFName } from 'pdf-lib';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { Jimp, JimpMime } from 'jimp';

import {
  arrayify,
  normalizePartNumber,
  selectBestRule as pickBestRule,
  selectLayerOption,
} from '../selPartNumberRules.js';
import { loadDeviceMetadata, SEL_DEVICES_DIR } from './deviceMetadata.js';

const PDF_RENDER_SCALE = 150 / 72;

// Wrap the shared rule engine with image-generation's stricter contract: empty
// metadata is a hard error, and a part number that matches nothing falls back
// to an explicit catch-all rule (or, failing that, the first rule) so an image
// still renders.
function selectBestRule(rules, model, pn, viewName) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(`Missing ${viewName} drawing metadata for ${model}`);
  }

  return pickBestRule(rules, pn, {
    fallback: (list) => {
      const catchAll = list.find((rule) => !rule.when || Object.keys(rule.when).length === 0);
      if (catchAll) return catchAll;

      console.warn(`drawings: no matching or unconditional ${viewName} drawing for ${model}:${pn}; using the first rule as a fallback`);
      return list[0];
    },
  });
}

function selectPdfFromList(pdfs, crops, viewName) {
  const pdf = arrayify(pdfs).find((candidate) => crops?.views_by_pdf?.[candidate]?.[viewName]);
  if (!pdf) {
    throw new Error(`Drawing metadata does not identify a ${viewName} PDF`);
  }
  return pdf;
}

function resolveDrawings(metadata, model, pn) {
  const drawingMetadata = metadata.model_to_drawings ?? {};
  const crops = metadata.crops ?? {};

  if (Array.isArray(drawingMetadata.front_and_rear)) {
    const rule = selectBestRule(drawingMetadata.front_and_rear, model, pn, 'front/rear');
    if (rule.pdfs) {
      return {
        front: selectPdfFromList(rule.pdfs, crops, 'front'),
        rear: selectPdfFromList(rule.pdfs, crops, 'rear'),
      };
    }

    return {
      front: rule.front_pdf,
      rear: rule.rear_pdf,
    };
  }

  const frontRule = selectBestRule(drawingMetadata.front, model, pn, 'front');
  const rearRule = selectBestRule(drawingMetadata.rear, model, pn, 'rear');
  return {
    front: frontRule.pdf,
    rear: rearRule.pdf,
  };
}

function addLayerEntries(target, entries) {
  for (const entry of arrayify(entries)) {
    if (entry?.object_id) target.objectIds.add(entry.object_id);
    if (entry?.name) target.names.add(entry.name);
  }
}

function resolveEnabledLayers(metadata, pdfName, pn) {
  const layerMetadata = metadata.model_to_layers ?? {};
  if (!layerMetadata.has_layers) return null;

  const rule = layerMetadata.rules_by_pdf?.[pdfName];
  if (!rule) return null;

  const enabled = { objectIds: new Set(), names: new Set() };
  addLayerEntries(enabled, rule.always ?? []);

  for (const [groupName, groupConfig] of Object.entries(rule.by_option_group ?? {})) {
    const selected = selectLayerOption(groupConfig, pn);
    if (!selected) {
      // Groups marked `optional` are legitimately absent for some configs
      // (mutually-exclusive slots) — skip them silently. A required group that
      // won't resolve is skipped too so the image still renders, but surfaced:
      // it usually means a metadata position is off for this part number.
      if (!groupConfig.optional) {
        console.warn(`drawings: unresolved layer option ${metadata.device}:${pdfName}:${groupName} for ${pn}`);
      }
      continue;
    }
    addLayerEntries(enabled, groupConfig.options[selected]);
  }

  return enabled;
}

function decodePdfString(value) {
  return value?.decodeText?.() ?? '';
}

async function configurePdfLayers(pdfBytes, enabledLayers) {
  if (!enabledLayers) return pdfBytes;

  const document = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const context = document.context;
  const ocProperties = document.catalog.lookup(PDFName.of('OCProperties'));
  const defaultConfig = ocProperties?.lookup(PDFName.of('D'));
  const ocgs = ocProperties?.lookup(PDFName.of('OCGs'));

  if (!defaultConfig || !ocgs) {
    throw new Error('PDF is missing optional content layer metadata');
  }

  const onLayers = PDFArray.withContext(context);
  const offLayers = PDFArray.withContext(context);

  for (let index = 0; index < ocgs.size(); index += 1) {
    const layerRef = ocgs.get(index);
    const layer = ocgs.lookup(index);
    const layerName = decodePdfString(layer.get(PDFName.of('Name')));
    const enabled = enabledLayers.objectIds.has(String(layerRef)) || enabledLayers.names.has(layerName);

    if (enabled) {
      onLayers.push(layerRef);
    } else {
      offLayers.push(layerRef);
    }
  }

  defaultConfig.set(PDFName.of('BaseState'), PDFName.of('OFF'));
  defaultConfig.set(PDFName.of('ON'), onLayers);
  defaultConfig.set(PDFName.of('OFF'), offLayers);

  return document.save({ useObjectStreams: false });
}

// One PDFium WASM instance for the process — init is not cheap, and every
// rendered view needs it.
let pdfiumLibrary = null;
function pdfium() {
  return (pdfiumLibrary ??= PDFiumLibrary.init());
}

/** Rasterize one page; the page size (PDF points) rides along so the crop
 *  math scales against the same geometry PDFium rendered from. */
async function renderPdfPage(pdfBytes, pageNumber) {
  const library = await pdfium();
  const document = await library.loadDocument(Buffer.from(pdfBytes));

  try {
    const page = document.getPage(pageNumber - 1);
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const rendered = await page.render({
      scale: PDF_RENDER_SCALE,
      render: async ({ data, width, height }) => {
        const image = new Jimp({ data: Buffer.from(data), width, height });
        return image.getBuffer(JimpMime.png);
      },
    });

    return {
      renderedPage: Buffer.from(rendered.data),
      pageSize: { width: originalWidth, height: originalHeight },
    };
  } finally {
    document.destroy();
  }
}

// Crop box (PDF points, bottom-left origin) -> pixel rect in the rendered page.
function cropPixels(view, pageSize, image) {
  const [xMin, yMin, xMax, yMax] = view.box;
  const xScale = image.bitmap.width / pageSize.width;
  const yScale = image.bitmap.height / pageSize.height;
  const x = Math.max(0, Math.round(xMin * xScale));
  const y = Math.max(0, Math.round((pageSize.height - yMax) * yScale));
  const w = Math.min(image.bitmap.width - x, Math.round((xMax - xMin) * xScale));
  const h = Math.min(image.bitmap.height - y, Math.round((yMax - yMin) * yScale));

  if (w <= 0 || h <= 0) {
    throw new Error(`Invalid crop box: ${view.box.join(', ')}`);
  }

  return { x, y, w, h };
}

async function renderedViewContext(metadata, deviceDir, pdfName, pn, pageNumber, renderCache, configuredPdfs) {
  const pdfPath = path.join(deviceDir, pdfName);
  const enabledLayers = resolveEnabledLayers(metadata, pdfName, pn);
  const cacheKey = [
    pdfName,
    pageNumber,
    [...(enabledLayers?.objectIds ?? [])].sort().join(','),
    [...(enabledLayers?.names ?? [])].sort().join(','),
  ].join('|');

  if (!renderCache.has(cacheKey)) {
    // The layer-configure pass (a full pdf-lib parse + save of a multi-MB
    // master drawing) is the expensive step; a caller that already produced
    // the configured bytes hands them in and we only rasterize.
    const configuredPdfBytes = configuredPdfs?.get(pdfName)
      ?? await configurePdfLayers(await fs.readFile(pdfPath), enabledLayers);
    renderCache.set(cacheKey, await renderPdfPage(configuredPdfBytes, pageNumber));
  }

  return renderCache.get(cacheKey);
}

// Generate <view>.png files for a device into outputDir. Returns the view
// names written (['front', 'rear']). Throws when the model has no metadata or
// its drawing PDF is absent — callers treat drawings as best-effort.
async function createImages(model, pn, outputDir, { devicesDir = SEL_DEVICES_DIR, configuredPdfs } = {}) {
  const metadata = await loadDeviceMetadata(model, devicesDir);
  if (!metadata) {
    throw new Error(`no drawing metadata for model: ${model}`);
  }
  const partNumber = normalizePartNumber(pn);
  const deviceDir = path.join(devicesDir, metadata.device);
  const drawings = resolveDrawings(metadata, metadata.device, partNumber);
  const crops = metadata.crops?.views_by_pdf ?? {};
  const renderCache = new Map();
  const written = [];

  await fs.mkdir(outputDir, { recursive: true });

  for (const [viewName, pdfName] of Object.entries(drawings)) {
    const view = crops[pdfName]?.[viewName];
    if (!view) {
      throw new Error(`Missing ${viewName} crop for ${metadata.device}:${pdfName}`);
    }

    const { pageSize, renderedPage } = await renderedViewContext(
      metadata,
      deviceDir,
      pdfName,
      partNumber,
      view.page ?? 1,
      renderCache,
      configuredPdfs,
    );

    const pageImage = await Jimp.read(renderedPage);
    const crop = cropPixels(view, pageSize, pageImage);
    await pageImage.crop(crop).write(path.join(outputDir, `${viewName}.png`));
    written.push(viewName);
  }

  return written;
}

// resolveDrawings / resolveEnabledLayers / configurePdfLayers are also the
// engine behind the DWGEN tool, which saves the filtered PDF itself instead
// of rasterizing crops.
export { createImages, resolveDrawings, resolveEnabledLayers, configurePdfLayers };
