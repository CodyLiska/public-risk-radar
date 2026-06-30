# Architecture Decisions

## Use live API calls instead of preloading datasets

I chose live upstream calls because the project is meant to show current risk signals, especially weather, AQI, wildfire, and stream gauge data.

## Persist normalized events, not whole reports

Whole reports have mixed freshness. Weather and AQI age quickly, while FEMA disaster history changes slowly. Persisting normalized events keeps history useful without pretending an old report is still current.

## First demo geography: Phoenix / Maricopa County

Phoenix gives a good demo mix: heat/weather alerts, AQI, flood zones, wildfire proximity, stream gauges, and county disaster history.
