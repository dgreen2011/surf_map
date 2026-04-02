import { LightningElement, api } from 'lwc';
import { loadScript, loadStyle } from 'lightning/platformResourceLoader';
import getMapInitData from '@salesforce/apex/StWorkLogMapController.getMapInitData';

import MAPBOX_GL from '@salesforce/resourceUrl/mapboxgl';
import MAP_BUNDLE_JS from '@salesforce/resourceUrl/sitetracker__MapBundleJs';
import JQUERY_351 from '@salesforce/resourceUrl/sitetracker__Jquery351';

const DEFAULT_CENTER = [-74.0060, 40.7128];
const DEFAULT_ZOOM = 9;
const SITE_ZOOM = 15;

const NO_DATA_FOUND_MESSAGE = 'No data found.';
const FAILED_TO_INITIALIZE_MESSAGE = 'Failed to initialize map.';
const SITE_DISPLAY_ERROR_MESSAGE = 'There was a problem displaying this map.';

const GLOBAL_MAP_PROVIDER_ELEMENT_ID = 'DataMapProviderName';
const GLOBAL_MAP_PROVIDER_ATTR = 'data-map-provider-name';

const MAPBOX_STANDARD_JS = 'mapbox-gl.js';
const MAPBOX_CSP_JS = 'mapbox-gl-csp.js';
const MAPBOX_CSP_WORKER = 'mapbox-gl-csp-worker.js';
const MAPBOX_CSS = 'mapbox-gl.css';

export default class StWorkLogMap extends LightningElement {
    @api recordId;
    @api workLogId;

    errorMessage = '';
    mapVisible = false;

    hasInitialized = false;
    librariesLoaded = false;
    featuresLoaded = false;

    geoData = {};
    mapInstance = null;
    resizeObserver = null;
    pendingBounds = null;
    windowResizeHandler = null;

    diagnostics = [];
    loadedMapboxBundleType = 'not-loaded';
    loadedMapboxScriptPath = '';
    loadedMapboxStylePath = '';
    loadedMapboxWorkerPath = '';

    renderedCallback() {
        if (this.hasInitialized) {
            return;
        }

        this.hasInitialized = true;
        void this.initialize();
    }

    disconnectedCallback() {
        const mapCanvas = this.mapCanvas;

        if (mapCanvas) {
            mapCanvas.style.display = 'none';
        }

        if (this.resizeObserver && mapCanvas) {
            try {
                this.resizeObserver.unobserve(mapCanvas);
            } catch (e) {
                // no-op
            }

            try {
                this.resizeObserver.disconnect();
            } catch (e) {
                // no-op
            }

            this.resizeObserver = null;
        }

        if (this.windowResizeHandler) {
            window.removeEventListener('resize', this.windowResizeHandler);
            this.windowResizeHandler = null;
        }

        if (this.mapInstance) {
            try {
                this.mapInstance.remove();
            } catch (e) {
                // no-op
            }

            this.mapInstance = null;
        }
    }

    get effectiveWorkLogId() {
        return this.recordId || this.workLogId;
    }

    get mapCanvas() {
        return this.template.querySelector('[data-id="map-canvas"]');
    }

    get hasError() {
        return !!this.errorMessage;
    }

    get mapContainerClass() {
        return `map-canvas${this.mapVisible && !this.errorMessage ? ' visible' : ''}`;
    }

    async initialize() {
        this.resetDiagnostics();

        try {
            this.recordDiagnostic('resourceRoot', MAPBOX_GL);

            if (!this.effectiveWorkLogId) {
                this.showErrorMessage('No work log id was provided.');
                return;
            }

            const initData = await getMapInitData({ workLogId: this.effectiveWorkLogId });
            this.geoData = this.safeParseJson(initData && initData.geoDataJson ? initData.geoDataJson : '{}');

            this.recordDiagnostic('recordId', this.effectiveWorkLogId);
            this.recordDiagnostic('mapProviderName', initData && initData.mapProviderName ? initData.mapProviderName : 'unknown');
            this.recordDiagnostic('hasGeoData', !!this.geoData);

            if ((initData && initData.errorMessage) || (this.geoData && this.geoData.error)) {
                this.showErrorMessage(
                    (initData && initData.errorMessage) ||
                    this.geoData.error ||
                    SITE_DISPLAY_ERROR_MESSAGE
                );
                return;
            }

            if (!this.hasValidData(this.geoData)) {
                this.showErrorMessage(NO_DATA_FOUND_MESSAGE);
                return;
            }

            if (
                initData &&
                initData.mapProviderName &&
                String(initData.mapProviderName).toLowerCase() !== 'mapbox'
            ) {
                throw this.createDetailedError(
                    `Unsupported map provider: ${initData.mapProviderName}`,
                    'unsupported-map-provider'
                );
            }

            await this.loadLibraries();

            const mapboxgl = this.getMapboxGlobal();
            const accessToken = this.getMapboxAccessToken();

            if (!mapboxgl) {
                throw this.createDetailedError(
                    'Mapbox global was not found after library load.',
                    'mapbox-global-missing'
                );
            }

            if (!accessToken) {
                throw this.createDetailedError(
                    'Mapbox access token was not found.',
                    'token-missing',
                    {
                        hasMapboxProvider: typeof window.MapboxProvider === 'function'
                    }
                );
            }

            mapboxgl.accessToken = accessToken;
            this.recordDiagnostic('accessTokenFound', true);

            this.createMap();
        } catch (error) {
            this.logDetailedError('initialize', error);
            this.showErrorMessage(this.normalizeError(error, FAILED_TO_INITIALIZE_MESSAGE));
        }
    }

    async loadLibraries() {
        if (this.librariesLoaded) {
            return;
        }

        await this.loadMapboxAssets();
        await this.loadStaticScript(JQUERY_351, 'jquery351');

        const providerElementHandle = this.ensureGlobalMapProviderElement();

        try {
            await this.loadStaticScript(MAP_BUNDLE_JS, 'sitetracker-map-bundle');
        } finally {
            this.restoreGlobalMapProviderElement(providerElementHandle);
        }

        const mapboxgl = this.getMapboxGlobal();

        if (!mapboxgl || typeof mapboxgl.Map !== 'function') {
            throw this.createDetailedError(
                'Mapbox GL failed to load.',
                'mapbox-global-missing-after-library-load',
                {
                    bundleType: this.loadedMapboxBundleType,
                    loadedScript: this.loadedMapboxScriptPath || 'none',
                    loadedStyle: this.loadedMapboxStylePath || 'none',
                    loadedWorker: this.loadedMapboxWorkerPath || 'none',
                    likelyFix: 'Check zip structure and prefer CSP bundle files.'
                }
            );
        }

        this.recordDiagnostic('mapboxGlobalFound', true);
        this.recordDiagnostic('mapboxHasMapConstructor', typeof mapboxgl.Map === 'function');

        this.librariesLoaded = true;
    }

    async loadMapboxAssets() {
        this.loadedMapboxStylePath = await this.tryLoadStyleCandidates(
            this.buildMapboxCandidates(MAPBOX_CSS),
            'mapbox-css'
        );

        const cspScriptPath = await this.tryLoadScriptCandidates(
            this.buildMapboxCandidates(MAPBOX_CSP_JS),
            'mapbox-csp-js',
            true
        );

        let mapboxgl = this.getMapboxGlobal();

        if (cspScriptPath && mapboxgl && typeof mapboxgl.Map === 'function') {
            this.loadedMapboxBundleType = 'csp';
            this.loadedMapboxScriptPath = cspScriptPath;
            this.loadedMapboxWorkerPath = this.resolveSiblingPath(
                cspScriptPath,
                MAPBOX_CSP_JS,
                MAPBOX_CSP_WORKER
            );

            mapboxgl.workerUrl = this.loadedMapboxWorkerPath;

            this.recordDiagnostic('mapboxBundleType', 'csp');
            this.recordDiagnostic('mapboxScriptPath', this.loadedMapboxScriptPath);
            this.recordDiagnostic('mapboxStylePath', this.loadedMapboxStylePath);
            this.recordDiagnostic('mapboxWorkerPath', this.loadedMapboxWorkerPath);

            return;
        }

        if (cspScriptPath) {
            this.recordDiagnostic(
                'mapboxCspLoadedButGlobalMissing',
                cspScriptPath
            );
        } else {
            this.recordDiagnostic(
                'mapboxCspBundleNotFound',
                this.buildMapboxCandidates(MAPBOX_CSP_JS)
            );
        }

        const standardScriptPath = await this.tryLoadScriptCandidates(
            this.buildMapboxCandidates(MAPBOX_STANDARD_JS),
            'mapbox-standard-js',
            false
        );

        this.loadedMapboxBundleType = 'standard';
        this.loadedMapboxScriptPath = standardScriptPath;

        mapboxgl = this.getMapboxGlobal();

        this.recordDiagnostic('mapboxBundleType', 'standard');
        this.recordDiagnostic('mapboxScriptPath', this.loadedMapboxScriptPath);
        this.recordDiagnostic('mapboxStylePath', this.loadedMapboxStylePath);

        if (!mapboxgl || typeof mapboxgl.Map !== 'function') {
            throw this.createDetailedError(
                'Mapbox GL script loaded, but the mapboxgl global was not created.',
                'mapbox-global-missing-after-standard-load',
                {
                    loadedScript: standardScriptPath,
                    loadedStyle: this.loadedMapboxStylePath,
                    likelyFix: 'Zip structure may be wrong, or use CSP bundle files instead of standard Mapbox GL.'
                }
            );
        }
    }

    buildMapboxCandidates(fileName) {
        return this.uniqueValues([
            `${MAPBOX_GL}/${fileName}`,
            `${MAPBOX_GL}/mapboxgl/${fileName}`
        ]);
    }

    async tryLoadScriptCandidates(candidates, label, optional) {
        const failures = [];

        for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];

            try {
                await loadScript(this, candidate);
                this.recordDiagnostic(`${label}Loaded`, candidate);
                return candidate;
            } catch (error) {
                const errorMessage = this.extractErrorMessage(error);
                failures.push(`${candidate} => ${errorMessage}`);
                this.recordDiagnostic(`${label}Failed`, `${candidate} => ${errorMessage}`);
            }
        }

        if (optional) {
            return null;
        }

        throw this.createDetailedError(
            `${label} failed to load.`,
            `${label}-load-failed`,
            {
                candidates,
                failures
            }
        );
    }

    async tryLoadStyleCandidates(candidates, label) {
        const failures = [];

        for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];

            try {
                await loadStyle(this, candidate);
                this.recordDiagnostic(`${label}Loaded`, candidate);
                return candidate;
            } catch (error) {
                const errorMessage = this.extractErrorMessage(error);
                failures.push(`${candidate} => ${errorMessage}`);
                this.recordDiagnostic(`${label}Failed`, `${candidate} => ${errorMessage}`);
            }
        }

        throw this.createDetailedError(
            `${label} failed to load.`,
            `${label}-load-failed`,
            {
                candidates,
                failures
            }
        );
    }

    async loadStaticScript(path, label) {
        try {
            await loadScript(this, path);
            this.recordDiagnostic(`${label}Loaded`, path);
        } catch (error) {
            throw this.createDetailedError(
                `${label} failed to load.`,
                `${label}-load-failed`,
                {
                    path,
                    originalError: this.extractErrorMessage(error)
                }
            );
        }
    }

    ensureGlobalMapProviderElement() {
        const existing = document.getElementById(GLOBAL_MAP_PROVIDER_ELEMENT_ID);

        if (existing) {
            const previousValue = existing.getAttribute(GLOBAL_MAP_PROVIDER_ATTR);
            existing.setAttribute(GLOBAL_MAP_PROVIDER_ATTR, 'mapbox');

            return {
                element: existing,
                created: false,
                previousValue
            };
        }

        const element = document.createElement('span');
        element.id = GLOBAL_MAP_PROVIDER_ELEMENT_ID;
        element.setAttribute(GLOBAL_MAP_PROVIDER_ATTR, 'mapbox');
        element.style.display = 'none';

        document.body.appendChild(element);

        return {
            element,
            created: true,
            previousValue: null
        };
    }

    restoreGlobalMapProviderElement(handle) {
        if (!handle || !handle.element) {
            return;
        }

        if (handle.created) {
            if (handle.element.parentNode) {
                handle.element.parentNode.removeChild(handle.element);
            }
            return;
        }

        if (handle.previousValue === null || handle.previousValue === undefined) {
            handle.element.removeAttribute(GLOBAL_MAP_PROVIDER_ATTR);
            return;
        }

        handle.element.setAttribute(GLOBAL_MAP_PROVIDER_ATTR, handle.previousValue);
    }

    getMapboxGlobal() {
        if (window.mapboxgl) {
            return window.mapboxgl;
        }

        if (typeof globalThis !== 'undefined' && globalThis.mapboxgl) {
            return globalThis.mapboxgl;
        }

        return null;
    }

    getMapboxAccessToken() {
        const mapboxgl = this.getMapboxGlobal();

        if (mapboxgl && mapboxgl.accessToken) {
            return mapboxgl.accessToken;
        }

        const ProviderCtor = window.MapboxProvider;
        if (typeof ProviderCtor !== 'function') {
            return null;
        }

        const provider = new ProviderCtor().getInstance();
        if (!provider || typeof provider.getApi !== 'function') {
            return null;
        }

        const api = provider.getApi();
        return api && api.accessToken ? api.accessToken : null;
    }

    createMap() {
        const initialConfig = this.buildInitialMapConfig(this.geoData);
        const mapCanvas = this.mapCanvas;
        const mapboxgl = this.getMapboxGlobal();

        if (!mapCanvas) {
            throw this.createDetailedError('Map canvas was not found.', 'map-canvas-missing');
        }

        if (!mapboxgl || typeof mapboxgl.Map !== 'function') {
            throw this.createDetailedError(
                'Mapbox GL Map constructor was not available.',
                'map-constructor-missing',
                {
                    bundleType: this.loadedMapboxBundleType,
                    loadedScript: this.loadedMapboxScriptPath || 'none'
                }
            );
        }

        try {
            this.mapInstance = new mapboxgl.Map({
                container: mapCanvas,
                style: 'mapbox://styles/mapbox/streets-v11',
                center: initialConfig.center,
                zoom: initialConfig.zoom
            });
        } catch (error) {
            throw this.createDetailedError(
                'Mapbox map creation failed.',
                'map-create-failed',
                {
                    bundleType: this.loadedMapboxBundleType,
                    loadedScript: this.loadedMapboxScriptPath || 'none',
                    loadedWorker: this.loadedMapboxWorkerPath || 'none',
                    originalError: this.extractErrorMessage(error),
                    likelyFix:
                        this.loadedMapboxBundleType === 'standard'
                            ? 'Replace static resource contents with mapbox-gl-csp.js, mapbox-gl-csp-worker.js, and mapbox-gl.css.'
                            : 'Verify the CSP worker file exists in the zip and the worker path is correct.'
                }
            );
        }

        this.mapInstance.on('error', (event) => {
            const eventMessage =
                event && event.error
                    ? this.extractErrorMessage(event.error)
                    : 'Unknown Mapbox error event';
            this.recordDiagnostic('mapErrorEvent', eventMessage);
            // eslint-disable-next-line no-console
            console.error('[StWorkLogMap] Mapbox error event', event);
        });

        this.mapInstance.addControl(new mapboxgl.NavigationControl());
        this.registerResizeHandlers();

        this.mapInstance.on('load', () => {
            this.mapVisible = true;
            mapCanvas.style.display = 'block';

            requestAnimationFrame(() => {
                this.resizeMap();

                this.mapInstance.once('resize', () => {
                    setTimeout(() => {
                        this.loadFeatures();
                    }, 50);
                });

                setTimeout(() => {
                    this.resizeMap();

                    if (!this.featuresLoaded) {
                        this.loadFeatures();
                    }
                }, 150);
            });
        });
    }

    registerResizeHandlers() {
        const mapCanvas = this.mapCanvas;

        if (!this.windowResizeHandler) {
            this.windowResizeHandler = () => {
                this.resizeMap();
            };

            window.addEventListener('resize', this.windowResizeHandler);
        }

        if (!this.resizeObserver && typeof ResizeObserver !== 'undefined' && mapCanvas) {
            this.resizeObserver = new ResizeObserver(() => {
                this.resizeMap();
            });

            this.resizeObserver.observe(mapCanvas);
        }
    }

    resizeMap() {
        if (!this.mapInstance) {
            return;
        }

        this.mapInstance.resize();

        if (this.pendingBounds) {
            requestAnimationFrame(() => {
                setTimeout(() => {
                    if (this.mapInstance && this.pendingBounds) {
                        this.mapInstance.fitBounds(this.pendingBounds, {
                            padding: 50
                        });
                    }
                }, 50);
            });
        }
    }

    loadFeatures() {
        if (!this.mapInstance || this.featuresLoaded) {
            return;
        }

        this.featuresLoaded = true;

        if (this.geoData.type === 'site') {
            this.addSiteMarker(this.geoData);
            return;
        }

        if (!this.geoData.gisPath) {
            this.showErrorMessage(NO_DATA_FOUND_MESSAGE);
            return;
        }

        const allFeatures = this.parseMultipleFeatures(this.geoData.gisPath);

        if (allFeatures.length === 0) {
            this.showErrorMessage(NO_DATA_FOUND_MESSAGE);
            return;
        }

        let allCoordinates = [];

        for (let i = 0; i < allFeatures.length; i += 1) {
            const coordinates = allFeatures[i];

            if (coordinates && coordinates.length > 0) {
                allCoordinates = allCoordinates.concat(coordinates);

                const actualGeometry = this.determineGeometryType(coordinates);
                const featureId = `feature-${i}`;

                if (actualGeometry === 'Polygon') {
                    this.addAreaPolygonWithId(coordinates, featureId);
                } else {
                    this.addSegmentLineWithId(coordinates, featureId);
                }
            }
        }

        if (allCoordinates.length > 0) {
            this.fitMapToBounds(allCoordinates);
        } else {
            this.showErrorMessage(NO_DATA_FOUND_MESSAGE);
        }
    }

    addSiteMarker(geoData) {
        const mapboxgl = this.getMapboxGlobal();

        new mapboxgl.Marker({
            color: '#0000FF'
        })
            .setLngLat([Number(geoData.longitude), Number(geoData.latitude)])
            .addTo(this.mapInstance);
    }

    addSegmentLineWithId(coordinates, featureId) {
        const mapboxgl = this.getMapboxGlobal();

        try {
            if (!coordinates || coordinates.length === 0) {
                this.showErrorMessage(NO_DATA_FOUND_MESSAGE);
                return;
            }

            this.mapInstance.addSource(featureId, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates
                    }
                }
            });

            this.mapInstance.addLayer({
                id: featureId,
                type: 'line',
                source: featureId,
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#0000FF',
                    'line-width': 4
                }
            });

            if (coordinates.length >= 2) {
                new mapboxgl.Marker({ color: '#0000FF' })
                    .setLngLat(coordinates[0])
                    .addTo(this.mapInstance);

                new mapboxgl.Marker({ color: '#0000FF' })
                    .setLngLat(coordinates[coordinates.length - 1])
                    .addTo(this.mapInstance);
            }
        } catch (error) {
            this.showErrorMessage(`Error displaying segment: ${error.message}`);
        }
    }

    addAreaPolygonWithId(coordinates, featureId) {
        try {
            if (!coordinates || coordinates.length === 0) {
                this.showErrorMessage('No valid coordinates found in area GIS path.');
                return;
            }

            const polygonCoordinates = [...coordinates];
            const first = polygonCoordinates[0];
            const last = polygonCoordinates[polygonCoordinates.length - 1];

            if (first[0] !== last[0] || first[1] !== last[1]) {
                polygonCoordinates.push(first);
            }

            this.mapInstance.addSource(featureId, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'Polygon',
                        coordinates: [polygonCoordinates]
                    }
                }
            });

            this.mapInstance.addLayer({
                id: `${featureId}-fill`,
                type: 'fill',
                source: featureId,
                paint: {
                    'fill-color': '#DBA400',
                    'fill-opacity': 0.3
                }
            });

            this.mapInstance.addLayer({
                id: `${featureId}-outline`,
                type: 'line',
                source: featureId,
                paint: {
                    'line-color': '#DBA400',
                    'line-width': 2
                }
            });
        } catch (error) {
            this.showErrorMessage(`Error displaying area: ${error.message}`);
        }
    }

    parseGISPath(gisPath) {
        const coordinates = [];

        if (!gisPath) {
            return coordinates;
        }

        try {
            if (String(gisPath).trim().startsWith('[')) {
                const parsed = JSON.parse(gisPath);
                const depth = this.getArrayDepth(parsed);

                if (depth === 2) {
                    return parsed;
                }

                if (depth === 3) {
                    return parsed[0] || [];
                }

                return parsed;
            }

            const pathPoints = String(gisPath).split(';');

            for (let i = 0; i < pathPoints.length; i += 1) {
                const point = pathPoints[i].trim();

                if (point) {
                    const latLng = point.split(',');

                    if (latLng.length >= 2) {
                        const lat = parseFloat(latLng[0].trim());
                        const lng = parseFloat(latLng[1].trim());

                        if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
                            coordinates.push([lng, lat]);
                        }
                    }
                }
            }
        } catch (error) {
            // no-op
        }

        return coordinates;
    }

    getArrayDepth(arr) {
        if (!Array.isArray(arr)) {
            return 0;
        }

        let maxDepth = 1;

        for (let i = 0; i < arr.length; i += 1) {
            if (Array.isArray(arr[i])) {
                const depth = 1 + this.getArrayDepth(arr[i]);
                maxDepth = Math.max(maxDepth, depth);
            }
        }

        return maxDepth;
    }

    parseMultipleFeatures(gisPath) {
        const allFeatures = [];

        if (!gisPath) {
            return allFeatures;
        }

        try {
            if (String(gisPath).trim().startsWith('[')) {
                const parsed = JSON.parse(gisPath);
                const depth = this.getArrayDepth(parsed);

                if (depth === 2) {
                    allFeatures.push(parsed);
                    return allFeatures;
                }

                if (depth === 3) {
                    return parsed;
                }
            }
        } catch (error) {
            // no-op
        }

        const singleFeature = this.parseGISPath(gisPath);
        if (singleFeature.length > 0) {
            allFeatures.push(singleFeature);
        }

        return allFeatures;
    }

    determineGeometryType(coordinates) {
        if (!coordinates || coordinates.length < 2) {
            return 'Point';
        }

        const first = coordinates[0];
        const last = coordinates[coordinates.length - 1];

        if (
            first.length >= 2 &&
            last.length >= 2 &&
            Math.abs(first[0] - last[0]) < 0.000001 &&
            Math.abs(first[1] - last[1]) < 0.000001
        ) {
            return 'Polygon';
        }

        return 'LineString';
    }

    fitMapToBounds(coordinates) {
        const mapboxgl = this.getMapboxGlobal();

        if (!coordinates || coordinates.length === 0 || !this.mapInstance || !mapboxgl) {
            return;
        }

        const bounds = new mapboxgl.LngLatBounds();

        coordinates.forEach((coord) => {
            bounds.extend(coord);
        });

        this.pendingBounds = bounds;
        this.resizeMap();

        const fitBounds = () => {
            if (this.mapInstance) {
                this.mapInstance.fitBounds(bounds, {
                    padding: 50
                });
            }
        };

        if (this.mapInstance.isStyleLoaded()) {
            this.mapInstance.once('resize', () => {
                requestAnimationFrame(fitBounds);
            });

            requestAnimationFrame(() => {
                setTimeout(fitBounds, 100);
            });
        } else {
            this.mapInstance.once('styledata', () => {
                this.resizeMap();

                this.mapInstance.once('resize', () => {
                    requestAnimationFrame(fitBounds);
                });

                requestAnimationFrame(() => {
                    setTimeout(fitBounds, 100);
                });
            });
        }
    }

    hasValidData(geoData) {
        if (
            geoData &&
            geoData.type === 'site' &&
            this.isFiniteNumber(geoData.latitude) &&
            this.isFiniteNumber(geoData.longitude)
        ) {
            return true;
        }

        if (geoData && geoData.gisPath) {
            const allFeatures = this.parseMultipleFeatures(geoData.gisPath);
            return allFeatures.length > 0;
        }

        return false;
    }

    buildInitialMapConfig(geoData) {
        let center = DEFAULT_CENTER;
        let zoom = DEFAULT_ZOOM;

        if (
            geoData &&
            geoData.type === 'site' &&
            this.isFiniteNumber(geoData.latitude) &&
            this.isFiniteNumber(geoData.longitude)
        ) {
            center = [Number(geoData.longitude), Number(geoData.latitude)];
            zoom = SITE_ZOOM;
        }

        return { center, zoom };
    }

    showErrorMessage(message) {
        this.errorMessage = message || SITE_DISPLAY_ERROR_MESSAGE;
        this.mapVisible = false;

        const mapCanvas = this.mapCanvas;
        if (mapCanvas) {
            mapCanvas.style.display = 'none';
        }
    }

    safeParseJson(value) {
        try {
            return value ? JSON.parse(value) : {};
        } catch (e) {
            return {};
        }
    }

    normalizeError(error, fallbackMessage) {
        if (error && error.body && error.body.message) {
            return error.body.message;
        }

        if (error && error.message) {
            return error.message;
        }

        return fallbackMessage;
    }

    extractErrorMessage(error) {
        if (error && error.body && error.body.message) {
            return error.body.message;
        }

        if (error && error.message) {
            return error.message;
        }

        try {
            return JSON.stringify(error);
        } catch (e) {
            return 'Unknown error';
        }
    }

    createDetailedError(baseMessage, code, extraDetails) {
        const parts = [`code=${code}`];

        if (this.loadedMapboxBundleType) {
            parts.push(`bundle=${this.loadedMapboxBundleType}`);
        }

        if (this.loadedMapboxScriptPath) {
            parts.push(`script=${this.loadedMapboxScriptPath}`);
        }

        if (this.loadedMapboxStylePath) {
            parts.push(`style=${this.loadedMapboxStylePath}`);
        }

        if (this.loadedMapboxWorkerPath) {
            parts.push(`worker=${this.loadedMapboxWorkerPath}`);
        }

        if (extraDetails) {
            Object.keys(extraDetails).forEach((key) => {
                const value = this.stringifyValue(extraDetails[key]);
                if (value) {
                    parts.push(`${key}=${value}`);
                }
            });
        }

        if (this.diagnostics.length > 0) {
            parts.push(`diag=${this.diagnostics.slice(-6).join(' ; ')}`);
        }

        return new Error(`${baseMessage} [${parts.join(' | ')}]`);
    }

    resetDiagnostics() {
        this.diagnostics = [];
        this.loadedMapboxBundleType = 'not-loaded';
        this.loadedMapboxScriptPath = '';
        this.loadedMapboxStylePath = '';
        this.loadedMapboxWorkerPath = '';
    }

    recordDiagnostic(label, value) {
        const entry = `${label}:${this.stringifyValue(value)}`;
        this.diagnostics.push(entry);

        if (this.diagnostics.length > 30) {
            this.diagnostics.shift();
        }

        // eslint-disable-next-line no-console
        console.log('[StWorkLogMap]', entry);
    }

    logDetailedError(stage, error) {
        // eslint-disable-next-line no-console
        console.error('[StWorkLogMap] Error', {
            stage,
            error: this.extractErrorMessage(error),
            diagnostics: this.diagnostics,
            bundleType: this.loadedMapboxBundleType,
            scriptPath: this.loadedMapboxScriptPath,
            stylePath: this.loadedMapboxStylePath,
            workerPath: this.loadedMapboxWorkerPath
        });
    }

    stringifyValue(value) {
        if (value === null || value === undefined) {
            return '';
        }

        if (Array.isArray(value)) {
            return value.join(', ');
        }

        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (e) {
                return '[object]';
            }
        }

        return String(value);
    }

    resolveSiblingPath(currentPath, oldFileName, newFileName) {
        if (!currentPath) {
            return '';
        }

        return currentPath.replace(oldFileName, newFileName);
    }

    uniqueValues(values) {
        return [...new Set(values.filter(Boolean))];
    }

    isFiniteNumber(value) {
        return value !== null && value !== undefined && !Number.isNaN(Number(value));
    }
}
