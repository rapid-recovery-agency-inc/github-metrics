# Sistema de Caché Perpetuo - GitHub Metrics

## Problema Resuelto

El error "Request quota exhausted for request GET /search/issues" se debe a que GitHub tiene límites muy estrictos en su API de búsqueda (solo 30 requests por minuto). Hemos implementado un **sistema de caché perpetuo** que elimina completamente este problema para reportes recurrentes.

## Características del Sistema de Caché

### 1. **Caché Perpetuo Inteligente** 🔒
- Los datos se guardan en SQLite y **NUNCA SE BORRAN AUTOMÁTICAMENTE**
- **Datos históricos (>7 días)**: ♾️ **PERPETUO** - nunca cambian una vez merged/closed
- **Datos recientes (1-7 días)**: 6 horas de caché - para updates menores
- **Datos de hoy**: 3 horas de caché - para precisión en tiempo real
- **Reviews y eventos**: ♾️ **PERPETUO** - inmutables una vez creados
- **Perfecto para reportes semanales (viernes) y mensuales (día 1)**

### 2. **Verificación de Cuota de API**
- Verifica el límite antes de cada petición
- Espera automáticamente si se agota la cuota
- Mantiene un buffer de seguridad (5 requests)

### 3. **Modo Offline**
- Ejecuta reportes usando solo datos del caché
- Ideal cuando se agota la cuota de API
- Mucho más rápido al evitar llamadas de red

## Cómo Usar

### 🎯 **Comando Principal (RECOMENDADO)**
```bash
npm run run
```
**🧠 Sistema Inteligente que:**
- ✅ **Usa caché automáticamente** cuando está disponible
- ✅ **Guarda datos frescos** cuando no hay caché  
- ✅ **Respeta TTL inteligente** (perpetuo para históricos, temporal para recientes)
- ✅ **Verifica cuota de API** antes de cada petición
- ✅ **Funciona siempre** - con o sin internet, con o sin cuota

### 🚀 **Opciones Especiales**

#### Solo Offline (sin usar API)
```bash
npm run offline-only
```
- ✅ **Solo usa datos del caché** - no hace peticiones de API
- ✅ **Súper rápido** - sin esperas de red
- ⚠️ Solo funciona con datos previamente cacheados

#### Forzar Actualización Completa  
```bash
npm run force-refresh
```
- ✅ **Ignora TODO el caché** y busca datos frescos
- ⚠️ Usa mucha cuota de API - usar solo cuando sea necesario

## Estados del Caché

El sistema te informará sobre el estado del caché:

```
📊 Cache Statistics: 1,250 items loaded from cache
⚡ Cache hit! This should significantly reduce API calls
```

```
⚠️ No cached data found - will need to fetch from API
```

```
🔒 Running in OFFLINE MODE - only cached data will be used
```

## Logs Informativos

Durante la ejecución verás logs como:
- `📦 Using cached PRs for 2024-01-01..2024-01-05 (45 items)`
- `🔍 Fetching PRs for 2024-01-06..2024-01-10, page 1`
- `💾 Cached 32 PRs for 2024-01-06..2024-01-10`
- `⚠️ Rate limit exceeded, skipping PRs for 2024-01-11..2024-01-15`

## Ubicación del Caché

Los datos se almacenan en:
- `disk-cache/github-metrics.db` - Base de datos SQLite
- `disk-cache/github-metrics.db-wal` - Write-Ahead Log
- `disk-cache/github-metrics.db-shm` - Shared Memory

## Recomendaciones de Uso

### En cualquier situación:
1. **Ejecuta `npm run run`** - ¡Funciona siempre! 🎯
2. El sistema decidirá automáticamente si usar caché o API
3. Si no hay cuota, usará solo caché existente
4. Si hay cuota, actualizará datos cuando sea necesario

### Para casos especiales:
- **Solo caché**: `npm run offline-only` 
- **Forzar actualización**: `npm run force-refresh`

### Para desarrollo/testing:
1. Usa modo offline para iteraciones rápidas
2. Ejecuta con API solo cuando necesites datos actualizados

## Configuración

### Variables de Entorno Disponibles:
- `GITHUB_OFFLINE_MODE=true` - Fuerza modo offline
- Todas las variables existentes siguen funcionando igual

### Configuración de TTL Inteligente:
En `src/constants.ts`:
```typescript
export const CACHE_TTL_HOURS = 7 * 24; // 7 días para datos actuales
export const CACHE_CONFIG = {
    HISTORICAL_TTL_HOURS: 30 * 24, // 30 días para datos >7 días
    RECENT_TTL_HOURS: 3 * 24,      // 3 días para datos 1-7 días  
    REVIEWS_TTL_HOURS: 14 * 24,    // 14 días para reviews/eventos
};
```

### ¿Por qué esta configuración?
- **Reportes semanales (viernes)**: Los datos de la semana anterior se cachean por 3 días, perfectos para el siguiente viernes
- **Reportes mensuales (día 1)**: Los datos históricos se mantienen por 30 días, ideales para reportes mensuales
- **Datos históricos**: Una vez que pasan 7 días, los datos raramente cambian (PRs merged, issues closed), se pueden cachear por mucho más tiempo
- **Reviews y eventos**: Estos datos prácticamente nunca cambian una vez creados

## Limpieza del Caché

El sistema limpia automáticamente entradas expiradas, pero puedes limpiar manualmente:
```bash
rm -rf disk-cache/
```

## Beneficios

✅ **Reduce drasticamente las peticiones API**  
✅ **Evita errores de cuota agotada**  
✅ **Reportes más rápidos con datos cacheados**  
✅ **Modo offline para emergencias**  
✅ **Transparente - no cambia la funcionalidad existente**  
✅ **Logs informativos para monitoreo**  

Este sistema te permite generar reportes incluso cuando GitHub limita tu acceso a la API, utilizando los datos que ya has recopilado anteriormente.
