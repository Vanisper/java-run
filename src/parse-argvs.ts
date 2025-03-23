let argvs: string[] | undefined = undefined

function checkArgvs(params: string[] | undefined) {
  if (!params) return false
  if (!Array.isArray(params)) return false

  return true
}

function parseBoolean(key: string, params?: string[]) {
  if (checkArgvs(argvs) && !checkArgvs(params)) params = argvs
  if (!checkArgvs(params)) return
  
  return params?.includes(key)
}

function parseKey(key: string, separator = "=", params?: string[]) {
  if (checkArgvs(argvs) && !checkArgvs(params)) params = argvs
  if (!checkArgvs(params)) return

  const temp = params?.find(item => item.startsWith(key))
  if (!temp) return
  return temp.replace(key, "").split('=').at(-1)
}

export default {
  set: (params: string[]) => {
    if (!checkArgvs(params)) return

    argvs = params
  },
  boolean: parseBoolean,
  booleans: (params: string[]) => params.some(item => parseBoolean(item)),
  key: parseKey,
}
