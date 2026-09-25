import { readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2] || 'src-tauri/gen/android/app/build.gradle.kts';
let source = readFileSync(target, 'utf8');
const marker = 'OPEN_HARNESS_RELEASE_SIGNING';
if (source.includes(marker)) process.exit(0);

const signing = `
    // ${marker}: values are supplied only by the release runner environment.
    signingConfigs {
        create("release") {
            storeFile = file(requireNotNull(System.getenv("OPEN_HARNESS_ANDROID_KEYSTORE_PATH")) { "Android keystore path is required" })
            storePassword = requireNotNull(System.getenv("OPEN_HARNESS_ANDROID_KEYSTORE_PASSWORD")) { "Android keystore password is required" }
            keyAlias = requireNotNull(System.getenv("OPEN_HARNESS_ANDROID_KEY_ALIAS")) { "Android key alias is required" }
            keyPassword = requireNotNull(System.getenv("OPEN_HARNESS_ANDROID_KEY_PASSWORD")) { "Android key password is required" }
        }
    }
`;
source = source.replace('android {\n', `android {\n${signing}`);
source = source.replace('        getByName("release") {\n', '        getByName("release") {\n            signingConfig = signingConfigs.getByName("release")\n');
if (!source.includes(marker) || !source.includes('signingConfig = signingConfigs.getByName("release")')) throw new Error('Generated Android Gradle layout changed; refusing to produce an unsigned release.');
writeFileSync(target, source);
