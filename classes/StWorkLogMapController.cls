public with sharing class StWorkLogMapController {
    public String workLogId { get; set; }
    private String geoDataJSONValue;

    private static final String WORK_LOG_OBJECT = 'sitetracker__Production_Work_Log__c';
    private static final String FIELD_SEGMENT = 'sitetracker__Segment__c';
    private static final String FIELD_AREA = 'sitetracker__st_Area__c';
    private static final String FIELD_SITE = 'sitetracker__Site__c';
    private static final String FIELD_GIS_PATH = 'sitetracker__st_GIS_Path__c';
    private static final String FIELD_LATITUDE = 'sitetracker__Location__Latitude__s';
    private static final String FIELD_LONGITUDE = 'sitetracker__Location__Longitude__s';

    private static final String APP_CONFIG_OBJECT = 'sitetracker__SiteTraker_Application_Configuration__mdt';
    private static final String APP_CONFIG_VALUE_FIELD = 'sitetracker__Configuration_Value__c';
    private static final String MAPBOX_VERSION_KEY = 'MAPBOX_VERSION';
    private static final String DEFAULT_MAPBOX_VERSION = 'v2.9.2';

    public class MapInitResponse {
        @AuraEnabled public String geoDataJson { get; set; }
        @AuraEnabled public String mapProviderName { get; set; }
        @AuraEnabled public String mapProviderUrl { get; set; }
        @AuraEnabled public String errorMessage { get; set; }
    }

    public String getGeoDataJSON() {
        return geoDataJSONValue;
    }

    public StWorkLogMapController() {
        workLogId = ApexPages.currentPage().getParameters().get('id');

        if (String.isNotBlank(workLogId)) {
            loadGeoData();
        } else {
            System.debug(LoggingLevel.WARN, 'StWorkLogMapController: No workLogId parameter provided in URL');
        }
    }

    @AuraEnabled(cacheable=true)
    public static MapInitResponse getMapInitData(Id workLogId) {
        MapInitResponse response = new MapInitResponse();
        response.mapProviderName = getMapProviderNameInternal();
        response.mapProviderUrl = getMapProviderUrlInternal();

        if (workLogId == null) {
            response.errorMessage = 'No work log id was provided.';
            response.geoDataJson = JSON.serialize(
                new Map<String, Object>{ 'error' => response.errorMessage }
            );
            return response;
        }

        try {
            Map<String, Object> geoData = buildGeoData(String.valueOf(workLogId));
            response.geoDataJson = JSON.serialize(geoData);
        } catch (Exception e) {
            System.debug(
                LoggingLevel.ERROR,
                'StWorkLogMapController.getMapInitData error for workLogId ' +
                String.valueOf(workLogId) +
                ': ' +
                e.getMessage()
            );

            response.errorMessage = e.getMessage();
            response.geoDataJson = JSON.serialize(
                new Map<String, Object>{ 'error' => response.errorMessage }
            );
        }

        return response;
    }

    private void loadGeoData() {
        try {
            Map<String, Object> geoData = buildGeoData(workLogId);
            geoDataJSONValue = JSON.serialize(geoData);
        } catch (Exception e) {
            System.debug(
                LoggingLevel.ERROR,
                'StWorkLogMapController.loadGeoData error for workLogId ' +
                workLogId +
                ': ' +
                e.getMessage()
            );

            geoDataJSONValue = JSON.serialize(
                new Map<String, Object>{ 'error' => e.getMessage() }
            );
        }
    }

    private static Map<String, Object> buildGeoData(String targetWorkLogId) {
        if (String.isBlank(targetWorkLogId)) {
            throw new AuraHandledException('No work log id was provided.');
        }

        if (!Schema.getGlobalDescribe().containsKey(WORK_LOG_OBJECT)) {
            throw new AuraHandledException('Object not found: ' + WORK_LOG_OBJECT);
        }

        String soql =
            'SELECT Id, ' +
            FIELD_SEGMENT + ', ' +
            FIELD_AREA + ', ' +
            FIELD_SITE + ', ' +
            FIELD_GIS_PATH + ', ' +
            FIELD_LATITUDE + ', ' +
            FIELD_LONGITUDE +
            ' FROM ' + WORK_LOG_OBJECT +
            ' WHERE Id = :targetWorkLogId' +
            ' WITH SECURITY_ENFORCED' +
            ' LIMIT 1';

        SObject workLog = Database.query(soql);

        Map<String, Object> geoData = new Map<String, Object>();

        String gisPath = (String) workLog.get(FIELD_GIS_PATH);

        if (String.isNotBlank(gisPath)) {
            if (workLog.get(FIELD_SEGMENT) != null) {
                geoData.put('type', 'segment');
                geoData.put('geometry', 'LineString');
            } else if (workLog.get(FIELD_AREA) != null) {
                geoData.put('type', 'area');
                geoData.put('geometry', 'Polygon');
            }

            geoData.put('gisPath', gisPath);
            return geoData;
        }

        Double latitude = toDouble(workLog.get(FIELD_LATITUDE));
        Double longitude = toDouble(workLog.get(FIELD_LONGITUDE));

        if (latitude != null && longitude != null) {
            geoData.put('type', 'site');
            geoData.put('latitude', latitude);
            geoData.put('longitude', longitude);
            geoData.put('geometry', 'Point');
        }

        return geoData;
    }

    private static Double toDouble(Object value) {
        if (value == null) {
            return null;
        }

        try {
            return Double.valueOf(String.valueOf(value));
        } catch (Exception e) {
            return null;
        }
    }

    public String getMapProviderName() {
        return getMapProviderNameInternal();
    }

    public String getMapProviderUrl() {
        return getMapProviderUrlInternal();
    }

    private static String getMapProviderNameInternal() {
        return 'mapbox';
    }

    private static String getMapProviderUrlInternal() {
        return 'https://api.mapbox.com/mapbox-gl-js/' + getMapboxVersion() + '/mapbox-gl.js';
    }

    private static String getMapboxVersion() {
        try {
            if (Schema.getGlobalDescribe().containsKey(APP_CONFIG_OBJECT)) {
                String soql =
                    'SELECT ' + APP_CONFIG_VALUE_FIELD +
                    ' FROM ' + APP_CONFIG_OBJECT +
                    ' WHERE DeveloperName = :MAPBOX_VERSION_KEY' +
                    ' LIMIT 1';

                SObject configRecord = Database.query(soql);
                String versionValue = (String) configRecord.get(APP_CONFIG_VALUE_FIELD);

                if (String.isNotBlank(versionValue)) {
                    return versionValue;
                }
            }
        } catch (Exception e) {
            System.debug(
                LoggingLevel.WARN,
                'StWorkLogMapController.getMapboxVersion fallback to default. Error: ' + e.getMessage()
            );
        }

        return DEFAULT_MAPBOX_VERSION;
    }
}
