/* eslint-disable @typescript-eslint/no-require-imports */
const {getDefaultConfig}=require('expo/metro-config');
const path=require('node:path');
const config=getDefaultConfig(__dirname);
config.watchFolders=[...config.watchFolders,path.resolve(__dirname,'../../lib')];
config.resolver.nodeModulesPaths=[path.resolve(__dirname,'node_modules')];
module.exports=config;
