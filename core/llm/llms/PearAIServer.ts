import { getHeaders } from "../../pearaiServer/stubs/headers.js";
import {
  ChatMessage,
  CompletionOptions,
  LLMOptions,
  ModelProvider,
  PearAuth,
} from "../../index.js";
import { SERVER_URL } from "../../util/parameters.js";
import { Telemetry } from "../../util/posthog.js";
import { BaseLLM } from "../index.js";
import { streamResponse, streamJSON } from "../stream.js";
import { attemptTokenCheck } from "../../db/token.js";
import { stripImages } from "../countTokens.js";

class PearAIServer extends BaseLLM {
  getCredentials: (() => Promise<PearAuth | undefined>) | undefined = undefined;
  setCredentials: (auth: PearAuth) => Promise<void> = async () => {};

  static providerName: ModelProvider = "pearai-server";
  constructor(options: LLMOptions) {
    super(options);
  }
  
  private async _getHeaders() {
    return {
      uniqueId: this.uniqueId || "None",
      extensionVersion: Telemetry.extensionVersion ?? "Unknown",
      os: Telemetry.os ?? "Unknown",
      "Content-Type": "application/json",
      ...(await getHeaders()),
    };
  }

  private async _countTokens(prompt: string, model: string, isPrompt: boolean) {
    if (!Telemetry.client) {
      throw new Error(
        'In order to use the server, telemetry must be enabled so that we can monitor abuse. To enable telemetry, set "allowAnonymousTelemetry": true in config.json and make sure the box is checked in IDE settings. If you use your own model (local or API key), telemetry will never be required.',
      );
    }
    const event = isPrompt
      ? "free_trial_prompt_tokens"
      : "free_trial_completion_tokens";
    Telemetry.capture(event, {
      tokens: this.countTokens(prompt),
      model,
    });
  }

  private _convertArgs(options: CompletionOptions): any {
    return {
      model: options.model,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      max_tokens: options.maxTokens,
      stop:
        options.model === "starcoder-7b"
          ? options.stop
          : options.stop?.slice(0, 2),
      temperature: options.temperature,
      top_p: options.topP,
    };
  }

  protected async *_streamComplete(
    prompt: string,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      options,
    )) {
      yield stripImages(chunk.content);
    }
  }

  protected _convertMessage(message: ChatMessage) {
    if (typeof message.content === "string") {
      return message;
    }

    const parts = message.content.map((part) => {
      return {
        type: part.type,
        text: part.text,
        image_url: { ...part.imageUrl, detail: "low" },
      };
    });
    return {
      ...message,
      content: parts,
    };
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    const args = this._convertArgs(this.collectArgs(options));

    await this._countTokens(
      messages.map((m) => m.content).join("\n"),
      args.model,
      true,
    );

    try {
      let creds = undefined;
      let tokens: { accessToken: string; refreshToken: string } | null = null;

      // Note: It is possible for the webapp tokens to get out of sync with the app tokens (i.e. app refreshes session but the webapp has not), so  we keep track of both just in case.
      if (this.getCredentials) {
        console.log("Attempting to get credentials...");
        creds = await this.getCredentials();
        if (creds) {
          tokens = await attemptTokenCheck(creds.loginAccessToken, creds.loginRefreshToken);
          if (!tokens) {
            console.log("Login tokens failed. Trying previous tokens...");
            tokens = await attemptTokenCheck(creds.accessToken, creds.refreshToken);
            if (!tokens) {
              console.log("Both login and previous token checks failed.");
            }
          } 
        
          if (tokens) {
            const hasChanged = (
              creds.loginAccessToken !== tokens.accessToken ||
              creds.loginRefreshToken !== tokens.refreshToken ||
              creds.accessToken !== tokens.accessToken ||
              creds.refreshToken !== tokens.refreshToken
            )
            if (hasChanged) {
              console.log("Credentials have changed. Updating...");
              creds.loginAccessToken = tokens.accessToken
              creds.loginRefreshToken = tokens.refreshToken
              creds.accessToken = tokens.accessToken
              creds.refreshToken = tokens.refreshToken
              this.setCredentials(creds)
            }
          }
          console.log("Successfully got credentials!", creds);
        }
      }
      else {
        console.log("Credentials are empty...");
      }

      if (!tokens) {
        // If we have token issues, let the server return an error and prompt login from user
        tokens = {accessToken: "", refreshToken: "" };
      }  

      this.apiKey = tokens.accessToken;
      this.refreshToken = tokens.refreshToken;
    } catch (error) {
      console.error("Error checking tokens:", error);
      // Handle the error (e.g., redirect to login page)
    }

    const response = await this.fetch(`${SERVER_URL}/server_chat`, {
      method: "POST",
      headers: {
        ...(await this._getHeaders()),
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        messages: messages.map(this._convertMessage),
        ...args,
      }),
    });

    let completion = "";

    for await (const value of streamJSON(response)) {
      // Handle initial metadata if necessary
      if (value.metadata && Object.keys(value.metadata).length > 0) {
        // Do something with metadata if needed, currently just logging
        console.log("Metadata received:", value.metadata);
      }

      if (value.content) {
        yield {
          role: "assistant",
          content: value.content,
        };
        completion += value.content;
      }
    }
    this._countTokens(completion, args.model, false);
  }

  async listModels(): Promise<string[]> {
    return [
      "pearai-latest",
    ];
  }
}

export default PearAIServer;
