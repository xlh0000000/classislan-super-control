using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClassIsland.Control.Plugin.Services;

/// <summary>
/// RFC 8785（JSON Canonicalization Scheme）序列化。
/// 与 ECMAScript <c>JSON.stringify</c> 对齐：对象键按 UTF-16 代码单元排序，
/// 字符串转义与数字（ECMAScript Number::toString）逐字节一致，
/// 以便与服务端 Node 实现计算出的摘要可比。
/// </summary>
public static class Jcs
{
    private static readonly JsonSerializerOptions NodeOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static string Canonicalize(string json)
    {
        using var document = JsonDocument.Parse(json);
        var builder = new StringBuilder(json.Length);
        Write(document.RootElement, builder);
        return builder.ToString();
    }

    public static string Canonicalize(JsonElement element)
    {
        var builder = new StringBuilder();
        Write(element, builder);
        return builder.ToString();
    }

    public static string Canonicalize(JsonNode? node)
        => node is null ? "null" : Canonicalize(node.ToJsonString(NodeOptions));

    private static void Write(JsonElement element, StringBuilder builder)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                builder.Append('{');
                var firstProperty = true;
                // JsonElement 保留输入顺序；JCS 要求按 UTF-16 代码单元（Ordinal）排序。
                foreach (var property in element.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal))
                {
                    if (!firstProperty) builder.Append(',');
                    firstProperty = false;
                    WriteString(property.Name, builder);
                    builder.Append(':');
                    Write(property.Value, builder);
                }
                builder.Append('}');
                break;
            case JsonValueKind.Array:
                builder.Append('[');
                var firstItem = true;
                foreach (var item in element.EnumerateArray())
                {
                    if (!firstItem) builder.Append(',');
                    firstItem = false;
                    Write(item, builder);
                }
                builder.Append(']');
                break;
            case JsonValueKind.String:
                WriteString(element.GetString() ?? "", builder);
                break;
            case JsonValueKind.Number:
                builder.Append(FormatNumber(element.GetDouble()));
                break;
            case JsonValueKind.True:
                builder.Append("true");
                break;
            case JsonValueKind.False:
                builder.Append("false");
                break;
            default:
                builder.Append("null");
                break;
        }
    }

    private static void WriteString(string value, StringBuilder builder)
    {
        builder.Append('"');
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            switch (character)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 0x20)
                        builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(character))
                    {
                        if (index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
                            builder.Append(character).Append(value[++index]);
                        else
                            builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else if (char.IsLowSurrogate(character))
                        builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    else
                        builder.Append(character);
                    break;
            }
        }
        builder.Append('"');
    }

    /// <summary>ECMAScript Number::toString，与 <c>JSON.stringify(number)</c> 的输出一致。</summary>
    internal static string FormatNumber(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value)) return "null";
        if (value == 0) return "0";
        var negative = value < 0;
        var text = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
        var exponentIndex = text.IndexOfAny(['e', 'E']);
        var exponent = 0;
        if (exponentIndex >= 0)
        {
            exponent = int.Parse(text[(exponentIndex + 1)..], CultureInfo.InvariantCulture);
            text = text[..exponentIndex];
        }
        var pointIndex = text.IndexOf('.');
        var fractionLength = pointIndex >= 0 ? text.Length - pointIndex - 1 : 0;
        var digits = (pointIndex >= 0 ? text.Remove(pointIndex, 1) : text).TrimStart('0');
        if (digits.Length == 0) return "0";
        var decimalShift = exponent - fractionLength;
        var magnitude = decimalShift + digits.Length - 1;
        var builder = new StringBuilder();
        if (negative) builder.Append('-');
        if (magnitude < -6 || magnitude >= 21)
        {
            builder.Append(digits[0]);
            if (digits.Length > 1) builder.Append('.').Append(digits[1..]);
            builder.Append('e').Append(magnitude >= 0 ? '+' : '-').Append(Math.Abs(magnitude).ToString(CultureInfo.InvariantCulture));
        }
        else if (magnitude >= digits.Length - 1)
        {
            builder.Append(digits).Append('0', magnitude - (digits.Length - 1));
        }
        else if (magnitude >= 0)
        {
            builder.Append(digits[..(magnitude + 1)]).Append('.').Append(digits[(magnitude + 1)..]);
        }
        else
        {
            builder.Append("0.").Append('0', -magnitude - 1).Append(digits);
        }
        return builder.ToString();
    }
}