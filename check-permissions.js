const fetch = require('node-fetch');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG = process.env.GITHUB_ORG;

// Lista de repositorios que están causando errores NOT_FOUND
const problematicRepos = [
    'insightt-backend',
    'rapid-website', 
    'foundd-js',
    'insightt-dashboard',
    'insightt-gamification-backend',
    'sloth-ui-web',
    'insightt-graphql',
    'insightt-shared',
    'media-microservice',
    'sloth-ui-mobile',
    'insightt-mobile',
    'foundd-pyengine',
    'lexnex-microservice'
];

async function checkTokenPermissions() {
    console.log('🔍 Verificando permisos del token de GitHub...\n');
    
    // Verificar información del token
    try {
        const userResponse = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        if (userResponse.ok) {
            const user = await userResponse.json();
            console.log(`✅ Token válido para usuario: ${user.login}`);
        } else {
            console.log(`❌ Token inválido: ${userResponse.status} ${userResponse.statusText}`);
            return;
        }
    } catch (error) {
        console.log(`❌ Error verificando token: ${error.message}`);
        return;
    }

    // Verificar acceso a la organización
    try {
        const orgResponse = await fetch(`https://api.github.com/orgs/${ORG}`, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        if (orgResponse.ok) {
            console.log(`✅ Acceso a organización: ${ORG}`);
        } else {
            console.log(`❌ Sin acceso a organización ${ORG}: ${orgResponse.status}`);
        }
    } catch (error) {
        console.log(`❌ Error verificando organización: ${error.message}`);
    }

    console.log('\n📋 Verificando acceso a repositorios problemáticos:\n');

    // Verificar cada repositorio problemático
    for (const repo of problematicRepos) {
        try {
            const repoResponse = await fetch(`https://api.github.com/repos/${ORG}/${repo}`, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            
            if (repoResponse.ok) {
                const repoData = await repoResponse.json();
                console.log(`✅ ${repo} - Acceso OK (${repoData.private ? 'Privado' : 'Público'})`);
            } else if (repoResponse.status === 404) {
                console.log(`❌ ${repo} - NO EXISTE o SIN PERMISOS (404)`);
            } else {
                console.log(`⚠️  ${repo} - Error ${repoResponse.status}: ${repoResponse.statusText}`);
            }
        } catch (error) {
            console.log(`❌ ${repo} - Error de conexión: ${error.message}`);
        }
        
        // Pequeña pausa para evitar rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Verificar permisos del token
    console.log('\n🔐 Verificando scopes del token:\n');
    try {
        const scopeResponse = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        const scopes = scopeResponse.headers.get('x-oauth-scopes');
        if (scopes) {
            console.log(`📜 Scopes del token: ${scopes}`);
            
            const requiredScopes = ['repo', 'read:org'];
            const hasRequired = requiredScopes.every(scope => 
                scopes.includes(scope) || scopes.includes('repo') // repo incluye muchos permisos
            );
            
            if (hasRequired) {
                console.log('✅ El token tiene los permisos necesarios');
            } else {
                console.log('❌ El token NO tiene todos los permisos necesarios');
                console.log('📋 Permisos requeridos: repo, read:org');
            }
        } else {
            console.log('⚠️  No se pudieron obtener los scopes del token');
        }
    } catch (error) {
        console.log(`❌ Error verificando scopes: ${error.message}`);
    }
}

checkTokenPermissions().catch(console.error);
