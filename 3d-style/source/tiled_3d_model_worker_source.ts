import {getArrayBuffer} from '../../src/util/ajax';
import FeatureIndex from '../../src/data/feature_index';
import {process3DTile} from './model_loader';
import {tileToMeter} from '../../src/geo/mercator_coordinate';
import Tiled3dModelBucket from '../data/bucket/tiled_3d_model_bucket';
import {OverscaledTileID} from '../../src/source/tile_id';
import {load3DTile} from '../util/loaders';
import EvaluationParameters from '../../src/style/evaluation_parameters';
import {makeFQID} from "../../src/util/fqid";

import type {CanonicalTileID} from '../../src/source/tile_id';
import type Actor from '../../src/util/actor';
import type StyleLayerIndex from '../../src/style/style_layer_index';
import type {
    WorkerSource,
    WorkerSourceTileRequest,
    WorkerSourceTiled3dModelRequest,
    WorkerSourceVectorTileCallback,
    WorkerSourceVectorTileResult
} from '../../src/source/worker_source';
import type {LoadVectorData} from '../../src/source/load_vector_tile';
import type Projection from '../../src/geo/projection/projection';
import type ModelStyleLayer from '../style/style_layer/model_style_layer';
import type {ImageId} from '../../src/style-spec/expression/types/image_id';
import type {StyleModelMap} from '../../src/style/style_mode';

class Tiled3dWorkerTile {
    tileID: OverscaledTileID;
    uid: number;
    zoom: number;
    tileZoom: number;
    canonical: CanonicalTileID;
    pixelRatio: number;
    tileSize: number;
    source: string;
    overscaling: number;
    projection: Projection;
    status: 'parsing' | 'done';
    reloadCallback: WorkerSourceVectorTileCallback | null | undefined;
    brightness: number | null | undefined;
    worldview: string | undefined;

    constructor(params: WorkerSourceTiled3dModelRequest, brightness?: number | null, worldview?: string) {
        this.tileID = new OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
        this.tileZoom = params.tileZoom;
        this.uid = params.uid;
        this.zoom = params.zoom;
        this.canonical = params.tileID.canonical;
        this.pixelRatio = params.pixelRatio;
        this.tileSize = params.tileSize;
        this.source = params.source;
        this.overscaling = this.tileID.overscaleFactor();
        this.projection = params.projection;
        this.brightness = brightness;
        this.worldview = worldview;
    }

    parse(
        data: ArrayBuffer,
        layerIndex: StyleLayerIndex,
        params: WorkerSourceTiled3dModelRequest,
        callback: WorkerSourceVectorTileCallback,
    ): void {
        this.status = 'parsing';
        const tileID = new OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
        const buckets: Tiled3dModelBucket[] = [];
        const layerFamilies = layerIndex.familiesBySource[params.source];
        const featureIndex = new FeatureIndex(tileID, params.promoteId);
        featureIndex.bucketLayerIDs = [];
        featureIndex.is3DTile = true;

        load3DTile(data)
            .then(gltf => {
                if (!gltf) return callback(new Error('Could not parse tile'));
                const hasMapboxMeshFeatures = (gltf.json.extensionsUsed && gltf.json.extensionsUsed.includes('MAPBOX_mesh_features')) ||
                                            (gltf.json.asset.extras && gltf.json.asset.extras['MAPBOX_mesh_features']);
                const hasMeshoptCompression = gltf.json.extensionsUsed && gltf.json.extensionsUsed.includes('EXT_meshopt_compression');

                const parameters = new EvaluationParameters(this.zoom, {brightness: this.brightness, worldview: this.worldview});
                for (const sourceLayerId in layerFamilies) {
                    for (const family of layerFamilies[sourceLayerId]) {
                        const layer = family[0] as ModelStyleLayer;
                        featureIndex.bucketLayerIDs.push(family.map((l) => makeFQID(l.id, l.scope)));
                        layer.recalculate(parameters, []);
                        // Nodes are created per layer which allows styling when multiple model layers are referencing the same source
                        const nodes = process3DTile(gltf, 1.0 / tileToMeter(params.tileID.canonical));
                        const bucket = new Tiled3dModelBucket(family as Array<ModelStyleLayer>, nodes, tileID, hasMapboxMeshFeatures, hasMeshoptCompression, this.brightness, featureIndex, this.worldview);
                        // Upload to GPU without waiting for evaluation if we are in diffuse path
                        if (!hasMapboxMeshFeatures) bucket.needsUpload = true;
                        buckets.push(bucket);
                        // do the first evaluation in the worker to avoid stuttering
                        bucket.evaluate(layer);
                    }
                }

                this.status = 'done';

                callback(null, {
                    buckets,
                    featureIndex,
                    collisionBoxArray: null,
                    glyphAtlasImage: null,
                    lineAtlas: null,
                    imageAtlas: null,
                    brightness: null,
                });
            })
            .catch((err) => callback(new Error(err.message)));
    }
}

class Tiled3dModelWorkerSource implements WorkerSource {
    actor: Actor;
    layerIndex: StyleLayerIndex;
    availableImages: ImageId[];
    availableModels: StyleModelMap;
    loading: Record<number, Tiled3dWorkerTile>;
    loaded: Record<number, Tiled3dWorkerTile>;
    brightness?: number;
    worldview: string | undefined;

    constructor(actor: Actor, layerIndex: StyleLayerIndex, availableImages: ImageId[], availableModels: StyleModelMap, isSpriteLoaded: boolean, loadVectorData?: LoadVectorData, brightness?: number, worldview?: string) {
        this.actor = actor;
        this.layerIndex = layerIndex;
        this.availableImages = availableImages;
        this.availableModels = availableModels;
        this.brightness = brightness;
        this.loading = {};
        this.loaded = {};

        this.worldview = worldview;
    }

    /**
     * Implements {@link WorkerSource#loadTile}.
     * @private
     */
    loadTile(params: WorkerSourceTiled3dModelRequest, callback: WorkerSourceVectorTileCallback) {
        const uid = params.uid;
        const workerTile = this.loading[uid] = new Tiled3dWorkerTile(params, this.brightness, this.worldview);
        getArrayBuffer(params.request, (err?: Error | null, data?: ArrayBuffer | null) => {
            const aborted = !this.loading[uid];
            delete this.loading[uid];

            if (aborted || err) {
                workerTile.status = 'done';
                if (!aborted) this.loaded[uid] = workerTile;
                return callback(err);
            }

            if (!data || data.byteLength === 0) {
                workerTile.status = 'done';
                this.loaded[uid] = workerTile;
                return callback();
            }

            const workerSourceVectorTileCallback = (err?: Error | null, result?: WorkerSourceVectorTileResult | null) => {
                workerTile.status = 'done';
                this.loaded = this.loaded || {};
                this.loaded[uid] = workerTile;

                if (err || !result) callback(err);
                else callback(null, result);
            };

            workerTile.parse(data, this.layerIndex, params, workerSourceVectorTileCallback);
        });
    }

    /**
     * Implements {@link WorkerSource#reloadTile}.
     * Re-parses a tile that has already been loaded. Yields the same data as {@link WorkerSource#loadTile}.
     * @private
     */
    reloadTile(params: WorkerSourceTiled3dModelRequest, callback: WorkerSourceVectorTileCallback) {
        const loaded = this.loaded;
        const uid = params.uid;
        if (loaded && loaded[uid]) {
            const workerTile = loaded[uid];
            workerTile.projection = params.projection;
            workerTile.brightness = params.brightness;

            const done = (err?: Error | null, data?: WorkerSourceVectorTileResult | null) => {
                const reloadCallback = workerTile.reloadCallback;
                if (reloadCallback) {
                    delete workerTile.reloadCallback;
                    this.loadTile(params, callback);
                }
                callback(err, data);
            };

            if (workerTile.status === 'parsing') {
                workerTile.reloadCallback = done;
            } else if (workerTile.status === 'done') {
                // do the request again
                this.loadTile(params, callback);
            }
        }
    }

    /**
     * Implements {@link WorkerSource#abortTile}.
     * Aborts loading a tile that is in progress.
     * @private
     */
    abortTile(params: WorkerSourceTileRequest, callback: WorkerSourceVectorTileCallback) {
        const uid = params.uid;
        const tile = this.loading[uid];
        if (tile) {
            delete this.loading[uid];
        }
        callback();
    }

    /**
     * Implements {@link WorkerSource#removeTile}.
     * Removes this tile from any local caches.
     * @private
     */
    removeTile(params: WorkerSourceTileRequest, callback: WorkerSourceVectorTileCallback) {
        const loaded = this.loaded,
            uid = params.uid;
        if (loaded && loaded[uid]) {
            delete loaded[uid];
        }
        callback();
    }

}

export default Tiled3dModelWorkerSource;
