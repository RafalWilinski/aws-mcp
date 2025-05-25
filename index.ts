process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = "1";

import { Project, SyntaxKind } from "ts-morph";
import { createContext, runInContext } from "node:vm";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as AWS from "aws-sdk";
import open from "open";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const codePrompt = `Your job is to answer questions about AWS environment by writing Javascript code using AWS SDK V2. The code must be adhering to a few rules:
- Must be preferring promises over callbacks
- Think step-by-step before writing the code, approach it logically
- MUST written in Javascript (NodeJS) using AWS-SDK V2
- Avoid hardcoded values like ARNs
- Code written should be as parallel as possible enabling the fastest and the most optimal execution
- Code should be handling errors gracefully, especially when doing multiple SDK calls (e.g. when mapping over an array). Each error should be handled and logged with a reason, script should continue to run despite errors
- DO NOT require or import "aws-sdk", it is already available as "AWS" variable
- Access to 3rd party libraries apart from "aws-sdk" is not allowed or possible
- For base64 encoding, use btoa() function instead of Buffer (Buffer is not available in this environment)
- Data returned from AWS-SDK must be returned as JSON containing only the minimal amount of data that is needed to answer the question. All extra data must be filtered out
- Code MUST "return" a value: string, number, boolean or JSON object. If code does not return anything, it will be considered as FAILED
- Whenever tool/function call fails, retry it 3 times before giving up with an improved version of the code based on the returned feedback
- When listing resources, ensure pagination is handled correctly so that all resources are returned
- Do not include any comments in the code
- When doing reduce, don't forget to provide an initial value
- Try to write code that returns as few data as possible to answer without any additional processing required after the code is run
- This tool can ONLY write code that interacts with AWS. It CANNOT generate charts, tables, graphs, etc. Please use artifacts for that instead
Be concise, professional and to the point. Do not give generic advice, always reply with detailed & contextual data sourced from the current AWS environment. Assume user always wants to proceed, do not ask for confirmation. I'll tip you $200 if you do this right.`;

const server = new Server(
  {
    name: "aws-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

let selectedProfile: string | null = null;
let selectedProfileCredentials: AWS.Credentials | AWS.SSO.RoleCredentials | any;
let selectedProfileRegion: string = "us-east-1";

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run-aws-code",
        description: "Run AWS code",
        inputSchema: {
          type: "object",
          properties: {
            reasoning: {
              type: "string",
              description: "The reasoning behind the code",
            },
            code: {
              type: "string",
              description: codePrompt,
            },
            profileName: {
              type: "string",
              description: "Name of the AWS profile to use",
            },
            region: {
              type: "string",
              description: "Region to use (if not provided, us-east-1 is used)",
            },
          },
          required: ["reasoning", "code"],
        },
      },
      {
        name: "list-credentials",
        description:
          "List all AWS credentials/configs/profiles that are configured/usable on this machine",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "select-profile",
        description:
          "Selects AWS profile to use for subsequent interactions. If needed, does SSO authentication",
        inputSchema: {
          type: "object",
          properties: {
            profile: {
              type: "string",
              description: "Name of the AWS profile to select",
            },
            region: {
              type: "string",
              description: "Region to use (if not provided, us-east-1 is used)",
            },
          },
          required: ["profile"],
        },
      },
    ],
  };
});

const RunAwsCodeSchema = z.object({
  reasoning: z.string(),
  code: z.string(),
  profileName: z.string().optional(),
  region: z.string().optional(),
});

const SelectProfileSchema = z.object({
  profile: z.string(),
  region: z.string().optional(),
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, c) => {
  const { name, arguments: args } = request.params;

  try {
    const { profiles, error } = await listCredentials();
    if (name === "run-aws-code") {
      const { reasoning, code, profileName, region } =
        RunAwsCodeSchema.parse(args);
      if (!selectedProfile && !profileName) {
        return createTextResponse(
          `Please select a profile first using the 'select-profile' tool! Available profiles: ${Object.keys(
            profiles
          ).join(", ")}`
        );
      }

      if (profileName) {
        selectedProfileCredentials = await getCredentials(
          profiles[profileName],
          profileName,
          profiles
        );
        selectedProfile = profileName;
        selectedProfileRegion = region || "us-east-1";
      }

      AWS.config.update({
        region: selectedProfileRegion,
        credentials: selectedProfileCredentials,
      });

      const wrappedCode = wrapUserCode(code);
      const wrappedIIFECode = `(async function() { return (async () => { ${wrappedCode} })(); })()`;
      const result = await runInContext(
        wrappedIIFECode,
        createContext({ AWS })
      );

      return createTextResponse(JSON.stringify(result));
    } else if (name === "list-credentials") {
      return createTextResponse(
        JSON.stringify({ profiles: Object.keys(profiles), error })
      );
    } else if (name === "select-profile") {
      const { profile, region } = SelectProfileSchema.parse(args);
      const credentials = await getCredentials(
        profiles[profile],
        profile,
        profiles
      );
      selectedProfile = profile;
      selectedProfileCredentials = credentials;
      selectedProfileRegion = region || "us-east-1";
      return createTextResponse("Authenticated!");
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
  }
});

function wrapUserCode(userCode: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile("userCode.ts", userCode);
  const lastStatement = sourceFile.getStatements().pop();

  if (
    lastStatement &&
    lastStatement.getKind() === SyntaxKind.ExpressionStatement
  ) {
    const returnStatement = lastStatement.asKind(
      SyntaxKind.ExpressionStatement
    );
    if (returnStatement) {
      const expression = returnStatement.getExpression();
      sourceFile.addStatements(`return ${expression.getText()};`);
      returnStatement.remove();
    }
  }

  return sourceFile.getFullText();
}

async function listCredentials() {
  let credentials: any;
  let configs: any;
  let error: any;
  try {
    credentials = new AWS.IniLoader().loadFrom({});
  } catch (error) {
    error = `Failed to load credentials: ${error}`;
  }
  try {
    configs = new AWS.IniLoader().loadFrom({ isConfig: true });
  } catch (error) {
    error = `Failed to load configs: ${error}`;
  }

  const profiles = { ...(credentials || {}), ...(configs || {}) };

  return { profiles, error };
}

async function getCredentials(
  creds: any,
  profileName: string,
  profiles: any
): Promise<AWS.Credentials | AWS.SSO.RoleCredentials | any> {
  let ssoStartUrl: string;
  let ssoRegion: string;

  if (creds.sso_start_url) {
    ssoStartUrl = creds.sso_start_url;
    ssoRegion = creds.region || "us-east-1";
  } else if (creds.sso_session) {
    const ssoSessionName = creds.sso_session;
    const ssoSessionConfig = profiles[ssoSessionName];

    if (!ssoSessionConfig) {
      throw new Error(
        `SSO session '${ssoSessionName}' not found in configuration`
      );
    }

    if (!ssoSessionConfig.sso_start_url) {
      throw new Error(`SSO session '${ssoSessionName}' missing sso_start_url`);
    }

    ssoStartUrl = ssoSessionConfig.sso_start_url;
    ssoRegion = ssoSessionConfig.sso_region || creds.region || "us-east-1";
  } else {
    return useAWSCredentialsProvider(profileName);
  }

  const oidc = new AWS.SSOOIDC({ region: ssoRegion });

  const registration = await oidc
    .registerClient({ clientName: "chatwithcloud", clientType: "public" })
    .promise();

  const auth = await oidc
    .startDeviceAuthorization({
      clientId: registration.clientId!,
      clientSecret: registration.clientSecret!,
      startUrl: ssoStartUrl,
    })
    .promise();

  if (auth.verificationUriComplete) {
    open(auth.verificationUriComplete);
  }

  let handleId: NodeJS.Timeout;
  return new Promise((resolve) => {
    handleId = setInterval(async () => {
      try {
        const createTokenReponse = await oidc
          .createToken({
            clientId: registration.clientId!,
            clientSecret: registration.clientSecret!,
            grantType: "urn:ietf:params:oauth:grant-type:device_code",
            deviceCode: auth.deviceCode,
          })
          .promise();

        const sso = new AWS.SSO({ region: ssoRegion });

        const credentials = await sso
          .getRoleCredentials({
            accessToken: createTokenReponse.accessToken!,
            accountId: creds.sso_account_id,
            roleName: creds.sso_role_name,
          })
          .promise();

        clearInterval(handleId);

        return resolve(credentials.roleCredentials!);
      } catch (error) {
        if ((error as Error).message !== null) {
          // terminal.error(error);
        }
      }
    }, 2500);
  });
}

export const useAWSCredentialsProvider = (
  profileName: string,
  region: string = "us-east-1",
  roleArn?: string
) => {
  const provider = fromNodeProviderChain({
    clientConfig: { region: region },
    profile: profileName,
    roleArn,
    // TODO: use a better MFA provider that works with Claude
    mfaCodeProvider: async (serialArn: string) => {
      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      return new Promise<string>((resolve) => {
        const prompt = () =>
          rl.question(`Enter MFA code for ${serialArn}: `, async (input) => {
            if (input.trim() !== "") {
              resolve(input.trim());
              rl.close();
            } else {
              // prompt again if no input
              prompt();
            }
          });
        prompt();
      });
    },
  });

  return provider();
};

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("Local Machine MCP Server running on stdio");
});

const createTextResponse = (text: string) => ({
  content: [{ type: "text", text }],
});
