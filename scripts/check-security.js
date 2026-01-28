#!/usr/bin/env node
/**
 * Pre-deployment Security Checker
 * Vérifie que toutes les mesures de sécurité sont en place avant le déploiement
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_ENV_VARS = [
  'NODE_ENV',
  'PORT',
  'MONGODB_URI'
];

const RECOMMENDED_ENV_VARS = [
  'GITHUB_WEBHOOK_SECRET',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET'
];

let errors = 0;
let warnings = 0;

console.log('🔒 Vérification de sécurité pré-déploiement\n');

// 1. Vérifier que .env existe
console.log('📋 Vérification des fichiers...');
if (!fs.existsSync('.env')) {
  console.error('❌ ERREUR: Fichier .env manquant');
  console.log('   Créez-le à partir de .env.example');
  errors++;
} else {
  console.log('✅ Fichier .env trouvé');
  
  // Charger .env
  require('dotenv').config();
  
  // 2. Vérifier les variables d'environnement requises
  console.log('\n🔑 Vérification des variables d\'environnement...');
  for (const varName of REQUIRED_ENV_VARS) {
    if (!process.env[varName]) {
      console.error(`❌ ERREUR: Variable ${varName} manquante`);
      errors++;
    } else {
      console.log(`✅ ${varName} défini`);
    }
  }
  
  for (const varName of RECOMMENDED_ENV_VARS) {
    if (!process.env[varName]) {
      console.warn(`⚠️  ATTENTION: Variable ${varName} non définie (recommandée)`);
      warnings++;
    } else {
      console.log(`✅ ${varName} défini`);
    }
  }
  
  // 3. Vérifier NODE_ENV en production
  if (process.env.NODE_ENV !== 'production') {
    console.warn('⚠️  ATTENTION: NODE_ENV n\'est pas "production"');
    warnings++;
  }
  
  // 4. Vérifier le secret webhook si configuré
  if (process.env.GITHUB_WEBHOOK_SECRET) {
    if (process.env.GITHUB_WEBHOOK_SECRET.length < 32) {
      console.error('❌ ERREUR: GITHUB_WEBHOOK_SECRET trop court (min 32 caractères)');
      console.log('   Générez-en un avec: openssl rand -hex 32');
      errors++;
    } else {
      console.log('✅ GITHUB_WEBHOOK_SECRET sécurisé');
    }
  }
}

// 5. Vérifier que .env n'est pas dans git
console.log('\n🔐 Vérification .gitignore...');
const gitignoreContent = fs.existsSync('.gitignore') 
  ? fs.readFileSync('.gitignore', 'utf8') 
  : '';

if (!gitignoreContent.includes('.env')) {
  console.error('❌ ERREUR: .env non présent dans .gitignore');
  errors++;
} else {
  console.log('✅ .env correctement ignoré par git');
}

// 6. Vérifier les dépendances de sécurité
console.log('\n📦 Vérification des dépendances de sécurité...');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const requiredDeps = [
  'express-rate-limit',
  'express-mongo-sanitize',
  'validator',
  'helmet'
];

for (const dep of requiredDeps) {
  if (!packageJson.dependencies[dep]) {
    console.error(`❌ ERREUR: Dépendance ${dep} manquante`);
    console.log(`   Installez avec: npm install ${dep}`);
    errors++;
  } else {
    console.log(`✅ ${dep} installé`);
  }
}

// 7. Vérifier que middleware/security.js existe
console.log('\n🛡️  Vérification des middlewares de sécurité...');
if (!fs.existsSync('middleware/security.js')) {
  console.error('❌ ERREUR: middleware/security.js manquant');
  errors++;
} else {
  console.log('✅ Middleware de sécurité présent');
}

// 8. Vérifier que node_modules/.bin/pm2 existe (si PM2 est requis)
console.log('\n🚀 Vérification PM2 (optionnel)...');
if (fs.existsSync('node_modules/.bin/pm2')) {
  console.log('✅ PM2 installé (recommandé pour production)');
} else {
  console.warn('⚠️  ATTENTION: PM2 non installé (recommandé pour production)');
  console.log('   Installez avec: npm install -g pm2');
  warnings++;
}

// Résumé
console.log('\n' + '='.repeat(50));
console.log('📊 RÉSUMÉ');
console.log('='.repeat(50));

if (errors === 0 && warnings === 0) {
  console.log('✅ Toutes les vérifications passées !');
  console.log('🎉 Votre application est prête pour le déploiement');
  process.exit(0);
} else {
  if (errors > 0) {
    console.error(`\n❌ ${errors} erreur(s) critique(s) trouvée(s)`);
    console.error('   → Corrigez ces erreurs avant de déployer');
  }
  if (warnings > 0) {
    console.warn(`\n⚠️  ${warnings} avertissement(s)`);
    console.warn('   → Recommandé mais non bloquant');
  }
  
  if (errors > 0) {
    console.log('\n❌ DÉPLOIEMENT NON RECOMMANDÉ');
    process.exit(1);
  } else {
    console.log('\n⚠️  DÉPLOIEMENT POSSIBLE MAIS AMÉLIORER LA CONFIGURATION');
    process.exit(0);
  }
}
