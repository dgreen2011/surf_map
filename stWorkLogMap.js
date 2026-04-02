import { LightningElement, api } from 'lwc';
import { loadScript, loadStyle } from 'lightning/platformResourceLoader';
import getMapInitData from '@salesforce/apex/StWorkLogMapController.getMapInitData';

// If these static resources are namespaced in your org, update the imports accordingly.
// Example: @salesforce/resourceUrl/sitetracker__MapBundleJs
import MAPBOX_GL from '@salesforce/resourceUrl/mapboxgl';
import MAP_BUNDLE_JS from '@salesforce/resourceUrl/MapBundleJs';
import JQUERY_351 from '@salesforce/resourceUrl/Jquery351';

const DEFAULT_CENTER = [-74.0060, 40.7128];
const DEFAULT_ZOOM = 9;
const SITE_ZOOM = 15;

const NO_DATA_FOUND_MESSAGE = 'No data found.';
const FAILED_TO_INITIALIZE_MESSAGE = 'Failed to initialize map.';
const SITE_DISPLAY_ERROR_MESSAGE = 'There was a problem displaying this map.';

export default class StWorkLogMap extends LightningElement {
    @api recordId;
    @api workLogId;

    errorMessage = '';
    mapVisible = false;

    resourcesLoaded = false;
    initializing = false;
    featuresLoaded = false;

    geoData = {};
    mapInstance = null;
    resizeObserver = null;
    pendingBounds = null;
    windowResizeHandler = null;

    renderedCallback() {
        if (this.initializing) {
            return;
        }

        this.initializing = true;
        this.initialize();
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
        return 'map-canvas' + (this.mapVisible && !this.errorMessage ? ' visible' : '');
    }

    async initialize() {
        try {
            if (!this.effectiveWorkLogId) {
                this.showErrorMessage('No work log id was provided.');
                return;
            }

            const initData = await getMapInitData({ workLogId: this.effectiveWorkLogId });
            this.geoData = this.safeParseJson(initData && initData.geoDataJson ? initData.geoDataJson : '{}');

            if ((initData && initData.errorMessage) || this.geoData.error) {
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

            await this.loadLibraries();

            if (!window.mapboxgl) {
                throw new Error('Mapbox GL failed to load.');
            }

            if (
                initData &&
                initData.mapProviderName &&
                String(initData.mapProviderName).toLowerCase() !== 'mapbox'
            ) {
                throw new Error('Unsupported map provider: ' + initData.mapProviderName);
            }

            const accessToken = this.getMapboxAccessToken();
            if (!accessToken) {
                throw new Error('Mapbox access token was not found.');
            }

            window.mapboxgl.accessToken = accessToken;
            this.createMap();
        } catch (error) {
            this.showErrorMessage(this.normalizeError(error, FAILED_TO_INITIALIZE_MESSAGE));
        }
    }

    async loadLibraries() {
        if (this.resourcesLoaded) {
            return;
        }

        await loadStyle(this, MAPBOX_GL + '/mapbox-gl.css');
        await loadScript(this, MAPBOX_GL + '/mapbox-gl.js');
        await loadScript(this, JQUERY_351);
        await loadScript(this, MAP_BUNDLE_JS);

        this.resourcesLoaded = true;
    }

    createMap() {
        const initialConfig = this.buildInitialMapConfig(this.geoData);
        const mapCanvas = this.mapCanvas;

        if (!mapCanvas) {
            throw new Error('Map canvas was not found.');
        }

        this.mapInstance = new window.mapboxgl.Map({
            container: mapCanvas,
            style: 'mapbox://styles/mapbox/streets-v11',
            center: initialConfig.center,
            zoom: initialConfig.zoom
        });

        this.mapInstance.addControl(new window.mapboxgl.NavigationControl());
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
                const featureId = 'feature-' + i;

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
        new window.mapboxgl.Marker({
            color: '#0000FF'
        })
            .setLngLat([Number(geoData.longitude), Number(geoData.latitude)])
            .addTo(this.mapInstance);
    }

    addSegmentLineWithId(coordinates, featureId) {
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
                        coordinates: coordinates
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
                new window.mapboxgl.Marker({ color: '#0000FF' })
                    .setLngLat(coordinates[0])
                    .addTo(this.mapInstance);

                new window.mapboxgl.Marker({ color: '#0000FF' })
                    .setLngLat(coordinates[coordinates.length - 1])
                    .addTo(this.mapInstance);
            }
        } catch (error) {
            this.showErrorMessage('Error displaying segment: ' + error.message);
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
                id: featureId + '-fill',
                type: 'fill',
                source: featureId,
                paint: {
                    'fill-color': '#DBA400',
                    'fill-opacity': 0.3
                }
            });

            this.mapInstance.addLayer({
                id: featureId + '-outline',
                type: 'line',
                source: featureId,
                paint: {
                    'line-color': '#DBA400',
                    'line-width': 2
                }
            });
        } catch (error) {
            this.showErrorMessage('Error displaying area: ' + error.message);
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
        if (!coordinates || coordinates.length === 0 || !this.mapInstance) {
            return;
        }

        const bounds = new window.mapboxgl.LngLatBounds();

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

    getMapboxAccessToken() {
        if (typeof window.MapProviderService !== 'function') {
            return null;
        }

        const providerService = new window.MapProviderService();

        if (!providerService || typeof providerService.currentProvider !== 'function') {
            return null;
        }

        const provider = providerService.currentProvider();

        if (!provider || typeof provider.getApi !== 'function') {
            return null;
        }

        const api = provider.getApi();

        if (!api || !api.accessToken) {
            return null;
        }

        return api.accessToken;
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

    isFiniteNumber(value) {
        return value !== null && value !== undefined && !Number.isNaN(Number(value));
    }
}
